import path from 'node:path';
import type { Agent } from './db.js';
import type { Host } from './host.js';

/**
 * Chat items extracted from an agent's JSONL session log. `id` is "<line byte offset>:<index>",
 * so any item can be re-fetched in full later and pages can continue from an offset.
 */
export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'meta';
  text: string;
  /** for tool calls: the tool name */
  tool?: string;
  truncated?: boolean;
}

const LIMITS = { user: 4000, assistant: 6000, tool: 240, meta: 300 } as const;

/** An image embedded in a log line (base64), served separately so chat pages stay small. */
export interface LineImage {
  mime: string;
  data: string;
}
const DATA_IMAGE = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi;

/** Replace embedded base64 images with `tw-img:<n>` references, collecting the data. */
function pullImages(text: string, images: LineImage[]): string {
  if (!text.includes('data:image/')) return text;
  return text.replace(DATA_IMAGE, (_, mime: string, data: string) => {
    images.push({ mime: mime.toLowerCase(), data: data.replace(/\s+/g, '') });
    return `tw-img:${images.length - 1}`;
  });
}

/** An image content block as Markdown (Claude: {source:{type:"base64"}}, Codex: image_url). */
function imageMarkdown(b: any): string {
  const src = b?.source;
  if (src?.type === 'base64' && src.data) return `![图片](data:${src.media_type || 'image/png'};base64,${src.data})`;
  const url = typeof b?.image_url === 'string' ? b.image_url : b?.image_url?.url;
  if (typeof url === 'string' && url) return `![图片](${url})`;
  return '[图片]';
}

function clip(item: Omit<ChatItem, 'id'>, full: boolean): Omit<ChatItem, 'id'> {
  const max = LIMITS[item.role];
  if (full || item.text.length <= max) return item;
  // tool output: the end usually matters more; prose: the beginning
  const text = item.role === 'tool' ? item.text.slice(0, max) : item.text.slice(0, max);
  return { ...item, text, truncated: true };
}

// ---------- Claude Code ----------

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof pick === 'string') return pick;
  const s = JSON.stringify(input);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : b && typeof b === 'object' && (b as { type?: string }).type === 'image' ? imageMarkdown(b) : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

/**
 * Claude Code logs pasted text wrapped as <pasted_content id="…">…</pasted_content id="…"> (the
 * page sends messages by pasting, so every multi-line one): show what was typed.
 */
const unwrapPasted = (s: string) =>
  s.includes('<pasted_content') ? s.replace(/<pasted_content(?: id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g, '$1').replace(/^\s*\n/, '') : s;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const stripTags = (s: string) => stripAnsi(s.replace(/<\/?[a-z-]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tagText = (s: string, tag: string) => stripAnsi(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1] ?? '').replace(/\s+/g, ' ').trim();

function parseClaude(o: Record<string, any>): Omit<ChatItem, 'id'>[] {
  // a message sent while Claude was busy: queued, then handed to the running turn as an
  // attachment (the queue-operation lines around it are bookkeeping and would duplicate it)
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && !o.isSidechain) {
    const a = o.attachment;
    const text = unwrapPasted(typeof a.prompt === 'string' ? a.prompt : blockText(a.prompt));
    if (!text?.trim()) return [];
    return a.commandMode && a.commandMode !== 'prompt' ? [{ role: 'meta', text: `${a.commandMode}: ${text}` }] : [{ role: 'user', text }];
  }
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain) return [];
  const content = o.message?.content;
  if (o.type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const out: Omit<ChatItem, 'id'>[] = [];
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') out.push({ role: 'tool', tool: b.name, text: toolSummary(b.name, b.input) });
    }
    return out;
  }
  // user
  if (o.isMeta) return [];
  if (o.isCompactSummary) return [{ role: 'meta', text: '（上下文已压缩）' }];
  if (typeof content === 'string') {
    // Claude Code injects notifications (background tasks, monitors) as user turns; only
    // origin.kind "human" is something the person actually typed
    const origin = o.origin?.kind as string | undefined;
    if ((origin && origin !== 'human') || o.promptSource === 'system' || /^\s*<task-notification>/.test(content)) {
      const summary = tagText(content, 'summary').replace(/^Monitor event: "(.*)"$/, '监控「$1」');
      const event = tagText(content, 'event');
      const status = tagText(content, 'status');
      const text = [summary, event].filter(Boolean).join(' → ') || stripTags(content);
      return text ? [{ role: 'meta', text: `后台任务${status ? `（${status}）` : ''}：${text}` }] : [];
    }
    if (/^\s*<(command-name|command-message|command-args)>/.test(content)) {
      const cmd = tagText(content, 'command-name') || `/${tagText(content, 'command-message')}`;
      const args = tagText(content, 'command-args');
      return [{ role: 'meta', text: `${cmd}${args ? ' ' + args : ''}` }];
    }
    if (/^\s*<(local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/.test(content)) {
      const cleaned = stripTags(content);
      return cleaned ? [{ role: 'meta', text: cleaned }] : [];
    }
    return [{ role: 'user', text: unwrapPasted(content) }];
  }
  if (Array.isArray(content)) {
    const out: Omit<ChatItem, 'id'>[] = [];
    for (const b of content) {
      if (b.type === 'tool_result') {
        const t = blockText(b.content).trim();
        if (t) out.push({ role: 'tool', tool: b.is_error ? 'error' : 'result', text: t });
      } else if (b.type === 'text' && b.text?.trim()) {
        out.push({ role: 'user', text: unwrapPasted(b.text) });
      } else if (b.type === 'image') {
        out.push({ role: 'user', text: imageMarkdown(b) });
      }
    }
    return out;
  }
  return [];
}

// ---------- Codex ----------

const CODEX_HIDDEN_USER = /^\s*(<(environment_context|user_instructions|permissions|user_shell_command|turn_aborted|developer)|# AGENTS\.md)/;

function parseCodex(o: Record<string, any>): Omit<ChatItem, 'id'>[] {
  if (o.type !== 'response_item') return [];
  const p = o.payload ?? {};
  switch (p.type) {
    case 'message': {
      if (p.role !== 'user' && p.role !== 'assistant') return [];
      const text = (p.content ?? [])
        .map((c: any) => (c.type === 'input_text' || c.type === 'output_text' ? c.text : c.type === 'input_image' ? imageMarkdown(c) : ''))
        .join('\n')
        .trim();
      if (!text || (p.role === 'user' && CODEX_HIDDEN_USER.test(text))) return [];
      return [{ role: p.role, text }];
    }
    case 'function_call':
    case 'custom_tool_call': {
      let input: any = p.arguments ?? p.input;
      try {
        if (typeof input === 'string') input = JSON.parse(input);
      } catch {
        /* keep raw */
      }
      const cmd = Array.isArray(input?.command) ? input.command.join(' ') : undefined;
      return [{ role: 'tool', tool: p.name, text: cmd ?? (typeof input === 'string' ? input : toolSummary(p.name, input)) }];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      let out: any = p.output;
      try {
        if (typeof out === 'string' && out.startsWith('{')) out = JSON.parse(out).output ?? out;
      } catch {
        /* keep raw */
      }
      const t = (typeof out === 'string' ? out : blockText(out)).trim();
      return t ? [{ role: 'tool', tool: 'result', text: t }] : [];
    }
    default:
      return [];
  }
}

export function parseLine(agent: Agent, line: string, offset: number, full = false, images: LineImage[] = []): ChatItem[] {
  if (!line.trim()) return [];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const items = agent === 'claude' ? parseClaude(o) : agent === 'codex' ? parseCodex(o) : [];
  return items.map((it, i) => ({ id: `${offset}:${i}`, ...clip({ ...it, text: pullImages(it.text, images) }, full) }));
}

// ---------- reading (through the host, so remote machines work the same as local) ----------

/** Bytes fetched per round trip. Latency to a host matters far more than bytes here. */
const CHUNK = 256 * 1024;

export interface Page {
  items: ChatItem[];
  /** offset of the earliest line included; pass as `before` for the next older page */
  start: number;
  /** offset just past the last complete line; live updates continue from here */
  end: number;
  hasMore: boolean;
}

/** Random access to a host file with one cached window, so a page usually costs one round trip. */
class HostFile {
  private winStart = 0;
  private win: Buffer = Buffer.alloc(0);
  constructor(
    private host: Host,
    private file: string,
  ) {}

  async tail(): Promise<number> {
    const { size, data } = await this.host.readTail(this.file, CHUNK);
    this.win = data;
    this.winStart = size - data.length;
    return size;
  }

  async read(from: number, to: number): Promise<Buffer> {
    if (from >= this.winStart && to <= this.winStart + this.win.length) return this.win.subarray(from - this.winStart, to - this.winStart);
    const start = Math.max(0, Math.min(from, to - CHUNK));
    this.win = await this.host.read(this.file, start, to);
    this.winStart = start;
    return this.win.subarray(from - start, to - start);
  }
}

/** Read backwards from `before` (or the end) until `limit` items are collected. */
export async function readPage(agent: Agent, host: Host, file: string, before: number | null, limit: number): Promise<Page> {
  const f = new HostFile(host, file);
  const size = await f.tail();
  let end = Math.min(before ?? size, size);
  if (before === null) {
    // the file may end with a line still being written: stop at the last newline
    let pos = end;
    end = 0;
    while (pos > 0) {
      const from = Math.max(0, pos - CHUNK);
      const nl = (await f.read(from, pos)).lastIndexOf(0x0a);
      if (nl !== -1) {
        end = from + nl + 1;
        break;
      }
      pos = from;
    }
  }

  const groups: ChatItem[][] = [];
  let count = 0;
  let start = end;
  let pos = end;
  // bytes [pos, pos + carry.length): the tail of a line that starts before pos
  let carry: Buffer = Buffer.alloc(0);
  while (pos > 0 && count < limit) {
    const from = Math.max(0, pos - CHUNK);
    const chunk = await f.read(from, pos);
    const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    const nls: number[] = [];
    for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) nls.push(i);
    // line k ends at nls[k]; the first one is only complete when we are at the file start
    const firstComplete = from === 0 ? 0 : 1;
    for (let k = nls.length - 1; k >= firstComplete && count < limit; k--) {
      const s = k === 0 ? 0 : nls[k - 1] + 1;
      start = from + s;
      const items = parseLine(agent, buf.subarray(s, nls[k]).toString('utf8'), start);
      if (items.length) {
        groups.push(items);
        count += items.length;
      }
    }
    carry = nls.length ? buf.subarray(0, nls[0] + 1) : Buffer.from(buf);
    pos = from;
  }
  return { items: groups.reverse().flat(), start, end, hasMore: start > 0 };
}

async function readLine(host: Host, file: string, offset: number): Promise<string> {
  const parts: Buffer[] = [];
  for (let pos = offset; ; pos += CHUNK) {
    const chunk = await host.read(file, pos, pos + CHUNK);
    const nl = chunk.indexOf(0x0a);
    parts.push(nl === -1 ? chunk : chunk.subarray(0, nl));
    if (nl !== -1 || chunk.length < CHUNK) break;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Read the single line at `offset` and return its items untruncated. */
export async function readFull(agent: Agent, host: Host, file: string, offset: number): Promise<ChatItem[]> {
  return parseLine(agent, await readLine(host, file, offset), offset, true);
}

/** The `n`th image embedded in the line at `offset` (see `tw-img:` references). */
export async function readImage(agent: Agent, host: Host, file: string, offset: number, n: number): Promise<LineImage | null> {
  const images: LineImage[] = [];
  parseLine(agent, await readLine(host, file, offset), offset, true, images);
  return images[n] ?? null;
}

/**
 * Follows a log from `offset` (tail -F on the host) and calls back with the items of each batch
 * of complete lines plus the offset just past them.
 */
export function followLog(agent: Agent, host: Host, file: string, offset: number, onItems: (items: ChatItem[], end: number) => void): () => void {
  const child = host.follow(file, offset);
  let pending: Buffer = Buffer.alloc(0);
  let pos = offset; // file offset of pending[0]
  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const last = pending.lastIndexOf(0x0a);
    if (last === -1) return;
    const items: ChatItem[] = [];
    for (let i = 0; i <= last; ) {
      const nl = pending.indexOf(0x0a, i);
      items.push(...parseLine(agent, pending.subarray(i, nl).toString('utf8'), pos + i));
      i = nl + 1;
    }
    pos += last + 1;
    pending = Buffer.from(pending.subarray(last + 1));
    onItems(items, pos);
  });
  child.stderr.resume();
  child.on('error', () => {});
  return () => {
    child.stdin.end();
    setTimeout(() => child.kill(), 2000).unref();
  };
}

// ---------- locating session logs ----------

export async function claudeTranscript(host: Host, sessionId: string): Promise<string | null> {
  const out = await host.shText(`for f in "$HOME"/.claude/projects/*/"$1".jsonl; do [ -f "$f" ] && printf '%s' "$f" && break; done; true`, [sessionId]);
  return out || null;
}

/**
 * Codex picks its own session id, so find the rollout file it created for our pane: newest first,
 * started after the pane, same cwd, not already claimed by another session.
 */
export async function findCodexRollout(host: Host, cwd: string, since: number, claimed: Set<string>): Promise<{ id: string; file: string } | null> {
  const minutes = Math.ceil((Date.now() - since) / 60000) + 1;
  const out = await host.shText(
    `d="$HOME/.codex/sessions"; [ -d "$d" ] || exit 0; ` +
      `find "$d" -name 'rollout-*.jsonl' -mmin -"$1" 2>/dev/null | while IFS= read -r f; do printf '%s\t' "$f"; head -n 1 "$f" | head -c 262144; echo; done`,
    [String(minutes)],
  );
  const candidates: { file: string; id: string; ts: string }[] = [];
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const file = line.slice(0, tab);
    if (claimed.has(file)) continue;
    try {
      const meta = JSON.parse(line.slice(tab + 1));
      const p = meta.payload ?? {};
      if (meta.type === 'session_meta' && p.id && path.posix.resolve(p.cwd ?? '') === path.posix.resolve(cwd)) candidates.push({ file, id: p.id, ts: String(p.timestamp ?? meta.timestamp ?? '') });
    } catch {
      /* partial or unrelated file */
    }
  }
  candidates.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return candidates[0] ?? null;
}

// ---------- Claude Code state (model, context usage) ----------

export interface ClaudeState {
  model: string;
  /** tokens in the context at the last request: input + cache reads + cache writes */
  contextTokens: number;
  /** best guess of the window: 1M when the session evidently uses it, else 200k */
  contextWindow: number;
  permissionMode: string;
}

/** Read the end of the log for the latest model and token usage. */
export async function claudeState(host: Host, file: string): Promise<ClaudeState> {
  const { data, size } = await host.readTail(file, 1024 * 1024);
  const text = data.toString('utf8');
  // the first line is probably cut off unless we have the whole file
  const lines = text.split('\n').slice(data.length < size ? 1 : 0);
  const st: ClaudeState = { model: '', contextTokens: 0, contextWindow: 200_000, permissionMode: '' };
  let oneM = /\(1M context\)|\[1m\]/i.test(text);
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"permission-mode"')) {
      try {
        st.permissionMode = JSON.parse(line).permissionMode ?? st.permissionMode;
      } catch {
        /* partial */
      }
    } else if (line.includes('"compact_boundary"')) {
      // /compact (or auto-compact): the context is now the summary; no reply has measured it yet
      try {
        const o = JSON.parse(line);
        if (o.subtype !== 'compact_boundary' || o.isSidechain) continue;
        const m = o.compactMetadata ?? {};
        if (m.preTokens > 200_000) oneM = true;
        st.contextTokens = Number(m.postTokens) || 0;
      } catch {
        /* partial */
      }
    } else if (line.includes('"usage"') && line.includes('"assistant"')) {
      try {
        const o = JSON.parse(line);
        const u = o.message?.usage;
        if (o.type !== 'assistant' || !u || o.isSidechain) continue;
        st.model = o.message.model || st.model;
        st.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } catch {
        /* partial */
      }
    }
  }
  if (st.contextTokens > 200_000) oneM = true;
  if (oneM) st.contextWindow = 1_000_000;
  return st;
}
