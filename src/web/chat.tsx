import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type ChatItem, type Page, type SessionInfo, type Status } from './api';
import { renderMarkdown, shown, splitImages } from './markdown';
import { hydrateMermaid } from './mermaid-lazy';
import { MAX_SESSIONS, saveChat } from './chat-store';
import { coarsePointer, liveStream, norm, quotePath, store } from './lib';
import { FilesView } from './files-view';
import { CopyBtn, Icon, Modal } from './ui';

// ---------------- chat ----------------

/** Thumbnails for images referenced from a plain-text item; tap opens the full image. */
function Images({ list }: { list: { url: string; alt: string }[] }) {
  if (!list.length) return null;
  return (
    <div class="msg-images">
      {list.map((im) => (
        <a key={im.url} class="md-img" href={im.url} target="_blank" rel="noopener noreferrer" title="点开看原图">
          <img src={shown(im.url)} alt={im.alt} loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  );
}
const imageCtx = (sid: number, it: ChatItem) => ({ api: `/_tw/api/sessions/${sid}`, off: it.id.split(':')[0] });

export function ToolGroup({ sid, items, onExpand }: { sid: number; items: ChatItem[]; onExpand: (it: ChatItem) => void }) {
  const last = items[items.length - 1];
  const calls = items.filter((i) => i.tool !== 'result' && i.tool !== 'error').length;
  const line = last.text.split('\n')[0] || '';
  // a dump of encoded data says nothing in one line
  const firstLine = /[A-Za-z0-9+/=]{60}/.test(line) && !/\s/.test(line.trim()) ? '（编码数据）' : line.slice(0, 90);
  return (
    <details class="tools">
      <summary>
        <span class="tool-badge">⚙ {calls || items.length}</span>
        <span class="tool-last">
          {last.tool && last.tool !== 'result' ? <b>{last.tool} </b> : null}
          {firstLine}
        </span>
      </summary>
      {items.map((it) => {
        const { text, images } = splitImages(it.text, imageCtx(sid, it));
        return (
          <div key={it.id} class={`tool-line ${it.tool === 'error' ? 'err' : ''}`}>
            {it.tool && it.tool !== 'result' && it.tool !== 'error' ? <b>{it.tool}</b> : <span class="dim">↳</span>}
            {text && <pre>{text}</pre>}
            {text && <CopyBtn class="tool-copy" text={it.truncated ? () => fullText(sid, it) : text} />}
            <Images list={images} />
            {it.truncated && (
              <button class="link" onClick={() => onExpand(it)}>
                展开全部
              </button>
            )}
          </div>
        );
      })}
    </details>
  );
}

/** The whole text of an item that came cut off. */
async function fullText(sid: number, it: ChatItem): Promise<string> {
  const full = await api<ChatItem[]>('GET', `/_tw/api/sessions/${sid}/message?off=${it.id.split(':')[0]}`);
  return full.find((f) => f.id === it.id)?.text ?? it.text;
}

export const mdCache = new Map<string, string>();
export function Markdown({ sid, id, text }: { sid: number; id: string; text: string }) {
  const key = `${sid}:${id}:${text.length}`;
  let html = mdCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(text, { api: `/_tw/api/sessions/${sid}`, off: id.split(':')[0] });
    if (mdCache.size > 500) mdCache.clear();
    mdCache.set(key, html);
  }
  const ref = useRef<HTMLDivElement>(null);
  const diagrams = html.includes('class="mermaid-block"');
  useEffect(() => {
    if (diagrams && ref.current) hydrateMermaid(ref.current);
  }, [html]);
  return <div ref={ref} class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Message({ sid, it, onExpand, onRewind }: { sid: number; it: ChatItem; onExpand: (it: ChatItem) => void; onRewind?: () => void }) {
  const [actions, setActions] = useState(false);
  const more = it.truncated && (
    <button class="link" onClick={() => onExpand(it)}>
      展开全文
    </button>
  );
  if (it.role === 'user') {
    const { text, images } = splitImages(it.text, imageCtx(sid, it));
    return (
      // tap (phones) or hover (desktop) shows what can be done with your own message
      <div class={`msg user ${actions ? 'show-actions' : ''}`} onClick={() => setActions((v) => !v)}>
        <div class="bubble">
          {text}
          <Images list={images} />
          {more}
        </div>
        <div class="msg-actions">
          <CopyBtn class="link" label="复制" text={it.truncated ? () => fullText(sid, it) : it.text} />
          {onRewind && (
            <button
              class="link"
              onClick={(e) => {
                e.stopPropagation();
                setActions(false);
                onRewind();
              }}
            >
              撤回到这之前…
            </button>
          )}
        </div>
      </div>
    );
  }
  if (it.role === 'meta') return <div class="msg meta">{it.text}</div>;
  return (
    <div class="msg assistant">
      <Markdown sid={sid} id={it.id} text={it.text} />
      {more}
      <div class="msg-tools">
        <CopyBtn text={it.truncated ? () => fullText(sid, it) : it.text} title="复制这条回复（Markdown 原文）" />
      </div>
    </div>
  );
}

export type Block = { kind: 'msg'; it: ChatItem } | { kind: 'tools'; items: ChatItem[] };
export function groupItems(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.role === 'tool') {
      if (prev?.kind === 'tools') prev.items.push(it);
      else out.push({ kind: 'tools', items: [it] });
    } else out.push({ kind: 'msg', it });
  }
  return out;
}

export const QUICK_KEYS: [string, string[], string][] = [
  ['1', ['1'], '选项 1'],
  ['2', ['2'], '选项 2'],
  ['3', ['3'], '选项 3'],
  ['↑', ['Up'], '上'],
  ['↓', ['Down'], '下'],
  ['⏎', ['Enter'], '回车'],
  ['Esc', ['Escape'], 'Esc（中断）'],
  ['Tab', ['Tab'], 'Tab'],
  ['⇧Tab', ['BTab'], 'Shift+Tab（切换模式）'],
  ['^C', ['C-c'], 'Ctrl+C'],
];

// ---------------- Claude Code controls ----------------

/** Slash commands offered while typing "/". Interactive ones open a menu in the TUI. */
export const SLASH: [string, string, boolean][] = [
  ['/model', '切换模型', true],
  ['/permissions', '权限规则（允许/拒绝哪些工具）', true],
  ['/usage', '套餐用量和额度', true],
  ['/context', '上下文占用明细', true],
  ['/rewind', '撤回：回到之前某条消息（可连代码一起撤销）', true],
  ['/compact', '压缩上下文（可附加说明）', false],
  ['/clear', '清空对话，开始新会话', false],
  ['/status', '版本、账号、模型等状态', true],
  ['/config', '设置', true],
  ['/cost', '本次会话花费', false],
  ['/mcp', 'MCP 服务器', true],
  ['/agents', '子 agent 管理', true],
  ['/resume', '切换到其他历史会话', true],
  ['/memory', '编辑 CLAUDE.md 记忆', true],
  ['/hooks', 'Hooks 配置', true],
  ['/init', '为项目生成 CLAUDE.md', false],
  ['/review', '代码审查', false],
  ['/rename', '重命名会话', false],
  ['/export', '导出对话', true],
  ['/doctor', '检查安装和配置', true],
  ['/login', '登录 / 切换账号', true],
  ['/help', '所有命令', true],
];

/** A slash command without arguments that opens a menu in the TUI: best handled in the terminal. */
export function isInteractive(text: string): boolean {
  const m = /^\s*(\/[\w-]+)\s*$/.exec(text);
  return !!m && SLASH.some(([c, , interactive]) => c === m[1] && interactive);
}

export interface ClaudeState {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  permissionMode?: string;
  /** live permission mode from the TUI footer */
  mode?: string;
}

export const MODE_LABEL: Record<string, string> = {
  auto: '自动模式',
  bypassPermissions: '跳过确认',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  default: '每次确认',
};

/** claude-opus-5-5 → Opus 5.5, claude-fable-5 → Fable 5 */
export function modelName(id?: string): string {
  if (!id) return '';
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const name = parts.filter((p) => !/^\d+$/.test(p)).map((p) => p[0].toUpperCase() + p.slice(1));
  const ver = parts.filter((p) => /^\d+$/.test(p)).join('.');
  return [...name, ver].filter(Boolean).join(' ');
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Thin bar above the chat: model · permission mode · context used. Tap for the control sheet. */
/** Where a restart of Claude stands, for the bar's feedback. */
export type Restart = '' | 'run' | 'done' | 'fail';

export function ClaudeBar({ st, update, restart = '', onOpen, onRestart }: { st: ClaudeState | null; update: boolean; restart?: Restart; onOpen: () => void; onRestart?: () => void }) {
  // always rendered (fixed height) so the chat below doesn't jump when the data arrives
  st ||= {};
  const mode = st.mode || st.permissionMode || '';
  const pct = st.contextTokens && st.contextWindow ? Math.min(100, (st.contextTokens / st.contextWindow) * 100) : null;
  const level = pct === null ? '' : pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
  return (
    <div class="cbar">
      {(update || restart) && onRestart && (
        <button
          class={`cbar-update ${restart}`}
          onClick={onRestart}
          disabled={restart === 'run'}
          title={restart === 'run' ? '正在重启 Claude，对话会接着继续' : 'Claude Code 已更新，重启后生效（对话会接着继续）'}
        >
          {restart === 'run' ? (
            <>
              <span class="spinner cbar-spin" /> 重启中…
            </>
          ) : restart === 'done' ? (
            '✓ 已重启'
          ) : restart === 'fail' ? (
            '重启失败'
          ) : (
            '有新版本 · 重启'
          )}
        </button>
      )}
      <button class="cbar-main" onClick={onOpen} title="Claude 状态与设置">
      <span class="cbar-model">{modelName(st.model) || 'Claude'}</span>
      {!st.model && <span class="cbar-loading">读取状态…</span>}
      {mode && <span class={`cbar-mode ${mode}`}>{MODE_LABEL[mode] ?? mode}</span>}
      {pct !== null && (
        <span class="cbar-ctx" title={`上下文已用 ${fmtTokens(st.contextTokens!)} / ${fmtTokens(st.contextWindow!)}`}>
          <span class="cbar-meter">
            <span class={`cbar-fill ${level}`} style={{ width: `${pct}%` }} />
          </span>
          <span class={`cbar-num ${level}`}>
            {fmtTokens(st.contextTokens!)}
            <span class="cbar-win">/{fmtTokens(st.contextWindow!)}</span>
          </span>
        </span>
      )}
      <span class="cbar-more">
        <Icon.more />
      </span>
      </button>
    </div>
  );
}

/** Control sheet: everything else goes through Claude Code's own commands in the TUI. */
export function ClaudePanel(props: { st: ClaudeState | null; canControl: boolean; onClose: () => void; run: (cmd: string) => void; sendKeys: (k: string[]) => void; onRestart: () => void }) {
  const { st } = props;
  const mode = st?.mode || st?.permissionMode || '';
  const pct = st?.contextTokens && st?.contextWindow ? Math.round((st.contextTokens / st.contextWindow) * 100) : null;
  const act = (cmd: string, confirmText?: string) => () => {
    if (confirmText && !confirm(confirmText)) return;
    props.run(cmd);
    props.onClose();
  };
  return (
    <Modal title="Claude" onClose={props.onClose}>
      <div class="cpanel">
        <div class="cp-row">
          <span class="dim">模型</span>
          <b>{modelName(st?.model) || '—'}</b>
          {props.canControl && (
            <button onClick={act('/model')}>切换…</button>
          )}
        </div>
        <div class="cp-row">
          <span class="dim">权限模式</span>
          <b>{MODE_LABEL[mode] ?? (mode || '—')}</b>
          {props.canControl && (
            <button onClick={() => props.sendKeys(['BTab'])} title="Shift+Tab">
              切换下一个
            </button>
          )}
        </div>
        <div class="cp-row">
          <span class="dim">上下文</span>
          <b>{st?.contextTokens ? `${fmtTokens(st.contextTokens)} / ${fmtTokens(st.contextWindow!)}${pct !== null ? `（${pct}%）` : ''}` : '—'}</b>
          {props.canControl && <button onClick={act('/context')}>明细…</button>}
        </div>
        {props.canControl && (
          <div class="cp-actions">
            <button onClick={act('/rewind')}>撤回 /rewind</button>
            <button onClick={act('/usage')}>用量 /usage</button>
            <button onClick={act('/permissions')}>权限规则 /permissions</button>
            <button onClick={act('/compact', '压缩上下文？Claude 会把之前的对话总结成摘要，释放空间。')}>压缩上下文 /compact</button>
            <button onClick={act('/clear', '清空对话、开始新会话？之前的对话仍可通过「从历史会话继续」找回。')}>清空对话 /clear</button>
            <button onClick={act('/status')}>状态 /status</button>
            <button onClick={act('/config')}>设置 /config</button>
            <button
              class="wide"
              onClick={() => {
                props.onClose();
                props.onRestart();
              }}
            >
              重启 Claude（更新版本后用，对话会接着继续）
            </button>
          </div>
        )}
        <p class="dim small">带「…」的会打开 Claude 自己的菜单，自动切到终端操作。也可以在输入框里直接输入任何 / 命令。</p>
      </div>
    </Modal>
  );
}

/** A numbered menu on the agent's screen (see server/screen.ts findChoices). */
export interface Choices {
  question: string;
  options: { n: number; label: string; selected: boolean }[];
}

/** Restart only the claude process; asks first if it is in the middle of something. */
export async function restartAgent(session: SessionInfo, status: Status): Promise<boolean> {
  const busy = status === 'busy' || status === 'waiting';
  if (busy && !confirm('Claude 正在执行任务，重启会中断它。确定重启？')) return false;
  try {
    await api('POST', `/_tw/api/sessions/${session.id}/restart-agent`, {});
  } catch (e: any) {
    // background shells / monitors would end with it: ask, then insist
    if (e.status !== 409) throw e;
    if (!confirm(`${e.message}。\n\n确定仍要重启？`)) return false;
    await api('POST', `/_tw/api/sessions/${session.id}/restart-agent`, { force: true });
  }
  return true;
}

/** A message sent from this page that hasn't shown up in the agent's log yet. */
export interface Pending {
  key: number;
  text: string;
  sent: boolean;
  at: number;
}

// Messages you sent that the agent's log doesn't show yet (Claude queues them while it works),
// kept per session outside the view so leaving and coming back keeps them.
const PENDING_MS = 30 * 60 * 1000;
const pendingStore = new Map<number, Pending[]>();
const pendingSubs = new Map<number, Set<(ps: Pending[]) => void>>();
const freshPending = (id: number) => (pendingStore.get(id) ?? []).filter((p) => Date.now() - p.at < PENDING_MS);

function updatePending(id: number, f: (ps: Pending[]) => Pending[]) {
  const next = f(freshPending(id));
  if (next.length) pendingStore.set(id, next);
  else pendingStore.delete(id);
  pendingSubs.get(id)?.forEach((fn) => fn(next));
}

/** Drop the placeholders of messages that have now shown up in the log. */
function arrived(id: number, items: ChatItem[]) {
  const texts = items.filter((i) => i.role === 'user').map((i) => norm(i.text));
  if (texts.length && pendingStore.has(id)) updatePending(id, (ps) => ps.filter((p) => !texts.some((a) => a === norm(p.text) || a.startsWith(norm(p.text).slice(0, 200)))));
}

function usePending(id: number): Pending[] {
  const [ps, setPs] = useState(() => freshPending(id));
  useEffect(() => {
    setPs(freshPending(id));
    let subs = pendingSubs.get(id);
    if (!subs) pendingSubs.set(id, (subs = new Set()));
    subs.add(setPs);
    return () => void subs.delete(setPs);
  }, [id]);
  return ps;
}

/** What a chat view had, so coming back to a session shows it at once (and where you were). */
export interface ChatCache {
  items: ChatItem[];
  page: { start: number; hasMore: boolean; pending: boolean };
  /** log offset the live stream continues from */
  end: number;
  at: number;
  /** null = was pinned to the bottom */
  scrollTop: number | null;
  claude: ClaudeState | null;
  /** the session's activity time when this was taken: unchanged activity = still current */
  activityAt: number;
  /** which conversation log the offsets belong to (a /clear starts a new one) */
  log?: string;
}
export const chatCache = new Map<number, ChatCache>();

/** Remember a chat view, in memory and in this browser's storage. */
export function putCache(id: number, c: ChatCache) {
  chatCache.delete(id); // most recently used last
  chatCache.set(id, c);
  if (chatCache.size > MAX_SESSIONS) chatCache.delete(chatCache.keys().next().value!);
  saveChat(id, c);
}
export function dropCache(id: number) {
  chatCache.delete(id);
  saveChat(id, null);
}

const offsetOf = (it: ChatItem) => Number(it.id.split(':')[0]);
/**
 * A cached view brought up to date with a fresh tail page: the new items appended when the page
 * reaches back to where the cache ended (same conversation), else just the page.
 */
function joinTail(c: ChatCache | undefined, pg: Page): Pick<ChatCache, 'items' | 'page'> {
  if (c && c.log && pg.log === c.log && pg.start <= c.end && c.items.length)
    return { items: [...c.items, ...pg.items.filter((i) => offsetOf(i) >= c.end)], page: c.page };
  return { items: pg.items, page: { start: pg.start, hasMore: pg.hasMore, pending: !!pg.pending } };
}
export const CACHE_FRESH_MS = 30 * 60 * 1000;

/** A cached view can be shown as is: recent, or nothing happened in the session since. */
export function cacheUsable(c: ChatCache | undefined, activityAt: number): c is ChatCache {
  return !!c && (Date.now() - c.at < CACHE_FRESH_MS || c.activityAt >= activityAt);
}

const prefetching = new Map<number, Promise<void>>();
/**
 * Load a session's latest messages ahead of opening it (the list does this in the background
 * for every session, and again on touch-down), so the chat shows at once instead of "加载中…".
 * Sessions that did nothing since their cached page are skipped.
 */
export function prefetchChat(s: SessionInfo): Promise<void> {
  if (s.agent === 'bash') return Promise.resolve();
  const c = chatCache.get(s.id);
  if (c && c.activityAt >= s.activityAt) return Promise.resolve();
  let p = prefetching.get(s.id);
  if (!p) {
    p = api<Page>('GET', `/_tw/api/sessions/${s.id}/messages?limit=20`)
      .then((pg) => {
        const now = chatCache.get(s.id);
        if (now && now.activityAt >= s.activityAt) return; // the chat view itself got there first
        putCache(s.id, { ...joinTail(now, pg), end: pg.end, at: Date.now(), scrollTop: null, claude: now?.claude ?? null, activityAt: s.activityAt, log: pg.log });
      })
      .catch(() => {})
      .finally(() => prefetching.delete(s.id));
    prefetching.set(s.id, p);
  }
  return p;
}

/** Prefetch a list of sessions one after another, in the background. Returns a cancel. */
export function prefetchAll(list: SessionInfo[]): () => void {
  let cancelled = false;
  let i = 0;
  const next = (): void => {
    if (cancelled) return;
    const s = list[i++];
    if (s) void prefetchChat(s).then(() => setTimeout(next, 150));
  };
  const t = setTimeout(next, 500);
  return () => {
    cancelled = true;
    clearTimeout(t);
  };
}

export function ChatView({ session, onOpenTerminal }: { session: SessionInfo; onOpenTerminal: () => void }) {
  // a cache that is behind is still shown at once, then brought up to date
  const cached = useMemo(() => chatCache.get(session.id), [session.id]);
  const current = useMemo(() => cacheUsable(cached, session.activityAt), [session.id]);
  const logRef = useRef(cached?.log);
  const [items, setItems] = useState<ChatItem[]>(cached?.items ?? []);
  const [claude, setClaude] = useState<ClaudeState | null>(cached?.claude ?? null);
  const [panel, setPanel] = useState(false);
  const [update, setUpdate] = useState(false);
  const isClaude = session.agent === 'claude';
  // shown right away when you press send; removed once the agent's log has the message
  const pending = usePending(session.id);
  const [page, setPage] = useState<{ start: number; hasMore: boolean; pending: boolean } | null>(cached?.page ?? null);
  const endRef = useRef(cached?.end ?? 0);
  const [state, setState] = useState<{ status: Status; preview: string; error?: string; choices?: Choices | null; suggestion?: string }>({ status: session.status, preview: '' });
  // the live screen grows at the bottom: keep its end in view
  const livePre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (livePre.current) livePre.current.scrollTop = livePre.current.scrollHeight;
  }, [state.preview]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(cached?.scrollTop == null);
  const restoreTop = useRef(cached?.scrollTop ?? null);
  // last scroll position, kept as we go: the element is already gone when we unmount
  const lastTop = useRef<number | null>(cached?.scrollTop ?? null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const id = session.id;
  // idle for a while and still not in the log: it won't come (e.g. the turn was interrupted and
  // Claude put the queued text back into its input box)
  const idleNow = state.status === 'idle' && pending.some((p) => p.sent);
  useEffect(() => {
    if (!idleNow) return;
    const t = setTimeout(() => updatePending(id, (ps) => ps.filter((p) => !p.sent || Date.now() - p.at < 15000)), 15000);
    return () => clearTimeout(t);
  }, [idleNow, id]);
  // bumped when the agent switches to another conversation (/clear): start over
  const [generation, setGeneration] = useState(0);

  // initial page (tail of the log), then the live stream from where it ended
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    setError('');
    // resume from the last byte offset we have (also when the stream has to be reopened)
    const begin = (end: number) => {
        let offset = end;
        endRef.current = end;
        stop = liveStream(
          () => `/_tw/api/sessions/${id}/stream?from=${offset}${logRef.current ? `&log=${encodeURIComponent(logRef.current)}` : ''}`,
          {
            msg: (fresh: ChatItem[], ev) => {
              if (ev.lastEventId) offset = endRef.current = Number(ev.lastEventId);
              if (fresh.length) {
                setItems((cur) => {
                  const seen = new Set(cur.map((i) => i.id));
                  return [...cur, ...fresh.filter((i) => !seen.has(i.id))];
                });
                arrived(id, fresh);
              }
              setPage((pg) => (pg && pg.pending ? { ...pg, pending: false } : pg));
            },
            state: (st: { status: Status; preview: string; error?: string; mode?: string; update?: boolean; choices?: Choices | null; suggestion?: string }) => {
              setState(st);
              setUpdate(!!st.update);
              if (st.mode !== undefined) setClaude((c) => (c ? { ...c, mode: st.mode } : c));
            },
            reset: () => {
              dropCache(id);
              logRef.current = undefined;
              setGeneration((g) => g + 1);
            },
          },
          setOnline,
        );
    };
    if (generation === 0 && cached && current) {
      // shown from the cache already: just continue the stream from where it was
      begin(cached.end);
    } else if (generation === 0 && cached) {
      // shown from an older cache: fetch the tail and append what's new since
      api<Page>('GET', `/_tw/api/sessions/${id}/messages?limit=30`)
        .then((p) => {
          if (cancelled) return;
          const j = joinTail(cached, p);
          arrived(id, j.items.slice(cached.items.length));
          if (j.page !== cached.page) stick.current = true; // replaced, not joined: start at the bottom
          setItems(j.items);
          setPage(j.page);
          logRef.current = p.log;
          begin(p.end);
        })
        // offline: keep showing the cache; the stream catches up once the server is reachable
        .catch(() => !cancelled && begin(cached.end));
    } else {
      setItems([]);
      setPage(null);
      stick.current = true;
      api<Page>('GET', `/_tw/api/sessions/${id}/messages?limit=30`)
        .then((p) => {
          if (cancelled) return;
          setItems(p.items);
          setPage({ start: p.start, hasMore: p.hasMore, pending: !!p.pending });
          logRef.current = p.log;
          begin(p.end);
        })
        .catch((e) => !cancelled && setError(e.message));
    }
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [id, generation]);

  // remember the view for next time
  useEffect(() => {
    if (!page) return;
    putCache(id, { items, page, end: endRef.current, at: Date.now(), scrollTop: chatCache.get(id)?.scrollTop ?? null, claude, activityAt: Math.max(session.activityAt, Date.now()), log: logRef.current });
  }, [items, page, claude]);
  useEffect(
    () => () => {
      const c = chatCache.get(id);
      if (c) {
        c.scrollTop = stick.current ? null : lastTop.current;
        saveChat(id, c);
      }
    },
    [id],
  );

  // model + context usage: refresh when the conversation moves on
  const lastAssistant = items.length ? items[items.length - 1].id : '';
  const firstState = useRef(true);
  useEffect(() => {
    if (!isClaude) return;
    const delay = firstState.current ? 0 : 800;
    firstState.current = false;
    const t = setTimeout(() => {
      api<ClaudeState | null>('GET', `/_tw/api/sessions/${id}/claude-state`).then(
        (st) => st && setClaude((c) => ({ ...st, mode: st.mode || c?.mode })),
        () => {},
      );
    }, delay);
    return () => clearTimeout(t);
  }, [id, lastAssistant, state.status === 'idle']);

  const runCommand = (cmd: string) =>
    api('POST', `/_tw/api/sessions/${id}/input`, { text: cmd })
      .then(() => isInteractive(cmd) && onOpenTerminal())
      .catch((e) => setError(e.message));
  const sendKeys = (keys: string[]) => api('POST', `/_tw/api/sessions/${id}/keys`, { keys }).catch((e) => setError(e.message));
  // restart feedback: "重启中…" at once, "✓ 已重启" when Claude is back (or after a while), "重启失败"
  const [restart, setRestart] = useState<Restart>('');
  // the server answers once Claude is back up (its input box is on screen), usually a few seconds
  const restartClaude = async () => {
    if (restart === 'run') return;
    setRestart('run');
    const started = Date.now();
    try {
      if (!(await restartAgent(session, state.status))) return setRestart('');
      // a spinner that flashes for a split second reads as a glitch
      await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - started))));
      setRestart('done');
      setTimeout(() => setRestart((r) => (r === 'done' ? '' : r)), 2500);
    } catch (e: any) {
      setError(e.message);
      setRestart('fail');
      setTimeout(() => setRestart((r) => (r === 'fail' ? '' : r)), 3000);
    }
  };

  // Claude Code's own rewind menu: pick the message to go back before, optionally undoing code too
  const canRewind = isClaude && session.access === 'control';
  const rewind = () => {
    if (state.status === 'busy') sendKeys(['Escape']);
    runCommand('/rewind');
  };

  const loadOlder = useCallback(async () => {
    if (!page?.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const p = await api<Page>('GET', `/_tw/api/sessions/${id}/messages?before=${page.start}&limit=30`);
      const el = scroller.current!;
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setItems((cur) => [...p.items, ...cur]);
      setPage((pg) => ({ ...pg!, start: p.start, hasMore: p.hasMore }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingOlder(false);
    }
  }, [id, page, loadingOlder]);

  const expand = async (it: ChatItem) => {
    const off = it.id.split(':')[0];
    try {
      const full = await api<ChatItem[]>('GET', `/_tw/api/sessions/${id}/message?off=${off}`);
      const byId = new Map(full.map((f) => [f.id, f]));
      setItems((cur) => cur.map((c) => byId.get(c.id) ?? c));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // keep the view pinned to the bottom unless the user scrolled up; keep position when prepending
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreTop.current !== null) {
      el.scrollTop = restoreTop.current;
      restoreTop.current = null;
    } else if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, state.preview, state.status]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    lastTop.current = el.scrollTop;
    if (el.scrollTop < 200 && page?.hasMore && !loadingOlder) loadOlder();
  };

  const blocks = useMemo(() => groupItems(items), [items]);
  const live = (state.status === 'busy' || state.status === 'waiting') && state.preview;

  return (
    <div class="chat">
      {isClaude && <ClaudeBar st={claude} update={update} restart={restart} onOpen={() => setPanel(true)} onRestart={session.access === 'control' ? restartClaude : undefined} />}
      {panel && <ClaudePanel st={claude} canControl={session.access === 'control'} onClose={() => setPanel(false)} run={runCommand} sendKeys={sendKeys} onRestart={restartClaude} />}
      <div class="scroller" ref={scroller} onScroll={onScroll}>
        <div class="messages">
          {page?.hasMore && (
            <button class="older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? '加载中…' : '加载更早的消息'}
            </button>
          )}
          {page && !items.length && (
            <div class="empty">{session.agent === 'bash' ? 'Shell 会话没有对话记录，请切换到「终端」。' : page.pending ? '还没有对话。在下方输入开始。' : '没有消息'}</div>
          )}
          {!page && !error && <div class="empty">加载中…</div>}
          {blocks.map((b) => (b.kind === 'tools' ? <ToolGroup key={b.items[0].id} sid={id} items={b.items} onExpand={expand} /> : <Message key={b.it.id} sid={id} it={b.it} onExpand={expand} onRewind={canRewind ? rewind : undefined} />))}
          {pending.map((p) => (
            <div key={p.key} class="msg user pending">
              <div class="bubble">
                {p.text}
                <span class="pending-tag">{p.sent ? '已发送' : '发送中…'}</span>
              </div>
            </div>
          ))}
          {live && state.status === 'waiting' && state.choices ? (
            // a menu on screen: show it as buttons; pressing the number picks it, like in the TUI
            <div class="live waiting">
              <div class="live-head">
                <span class="dot waiting" />
                等待你选择
              </div>
              {state.choices.question && <div class="choice-q">{state.choices.question}</div>}
              <div class="choices">
                {state.choices.options.map((o) => (
                  <button key={o.n} class={o.selected ? 'sel' : ''} disabled={session.access !== 'control'} onClick={() => sendKeys([String(o.n)])}>
                    <b>{o.n}</b>
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
              <details class="raw">
                <summary>查看原始画面</summary>
                <pre>{state.preview}</pre>
              </details>
            </div>
          ) : (
            live && (
              <div class={`live ${state.status}`}>
                <div class="live-head">
                  <span class={`dot ${state.status}`} />
                  {state.status === 'waiting' ? '等待你确认（可用下方快捷键，或切到终端）' : '实时画面'}
                </div>
                <pre ref={livePre}>{state.preview}</pre>
              </div>
            )
          )}
        </div>
      </div>
      {error && (
        <div class="banner error" onClick={() => setError('')}>
          {error}
        </div>
      )}
      {!online && <div class="banner">连接中断，正在重连…</div>}
      {online && state.status === 'offline' && <div class="banner error">主机离线{state.error ? `：${state.error}` : ''}，恢复后会自动重连</div>}
      {session.access === 'control' ? (
        <Composer
          sessionId={id}
          status={state.status}
          suggestion={state.status === 'idle' ? state.suggestion : ''}
          slash={isClaude}
          agent={session.agent}
          onInteractive={onOpenTerminal}
          onPending={(text) => {
            // a shell has no chat log to confirm the message: don't show a placeholder
            if (session.agent === 'bash') return () => {};
            const key = Date.now() + Math.random();
            stick.current = true;
            // kept until it shows up in the log: Claude may hold it in its queue for a long turn
            // (and dropped after PENDING_MS in case it never does)
            updatePending(id, (ps) => [...ps, { key, text, sent: false, at: Date.now() }]);
            return (ok: boolean) =>
              updatePending(id, (ps) => (ok ? ps.map((p) => (p.key === key ? { ...p, sent: true } : p)) : ps.filter((p) => p.key !== key)));
          }}
        />
      ) : (
        <div class="readonly">只读：你没有这个会话的操作权限</div>
      )}
    </div>
  );
}

export function Composer(props: {
  sessionId: number;
  status: Status;
  /** offer Claude Code slash commands */
  slash?: boolean;
  agent?: SessionInfo['agent'];
  onInteractive?: () => void;
  onPending: (text: string) => (ok: boolean) => void;
  /** Claude Code's suggested next message: shown in the empty box, sent as is with 发送 / Enter */
  suggestion?: string;
}) {
  const { sessionId, status, onPending } = props;
  const draftKey = `tw:draft:${sessionId}`;
  const [text, setText] = useState(() => store.get(draftKey) || '');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const coarse = coarsePointer;
  // phones: the quick keys stay folded until needed (or the agent asks for a choice)
  const [showKeys, setShowKeys] = useState(!coarse);
  const keysOpen = showKeys || status === 'waiting';

  useEffect(() => setText(store.get(draftKey) || ''), [draftKey]);
  // a suggestion in the empty box is sized like text, so it isn't cut off
  const hintText = !text ? props.suggestion || '' : '';
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (hintText) el.value = hintText;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, hintText ? 120 : 220) + 'px';
    if (hintText) el.value = '';
  }, [text, hintText]);

  const update = (v: string) => {
    setText(v);
    store.set(draftKey, v || null);
  };

  // Files go into the message as paths, where the cursor was: picked on the host, or uploaded
  // from this device first (the picker / file dialog takes the focus, so the cursor is kept).
  const caret = useRef<{ start: number; end: number; text: string } | null>(null);
  const keepCaret = () => {
    const el = ta.current;
    caret.current = el ? { start: el.selectionStart, end: el.selectionEnd, text: el.value } : null;
  };
  const insertPaths = (paths: string[]) => {
    const el = ta.current;
    const cur = el?.value ?? '';
    const c = caret.current;
    // the kept cursor if nothing changed since; else where the cursor is now, or the end
    const [start, end] = c && c.text === cur ? [c.start, c.end] : el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : [cur.length, cur.length];
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const piece = (before && !/\s$/.test(before) ? ' ' : '') + paths.map(quotePath).join(' ') + (!after || !/^\s/.test(after) ? ' ' : '');
    const next = before + piece + after;
    const pos = before.length + piece.length;
    update(next);
    caret.current = { start: pos, end: pos, text: next }; // the next one goes after this one
    requestAnimationFrame(() => {
      const t = ta.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(pos, pos);
    });
  };
  const [files, setFiles] = useState<{ key: number; name: string; error?: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const upload = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = Date.now() + Math.random();
      const name = file.name || `paste-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
      setFiles((fs) => [...fs, { key, name }]);
      fetch(`/_tw/api/sessions/${sessionId}/upload`, { method: 'POST', body: file, headers: { 'X-File-Name': encodeURIComponent(name) }, credentials: 'same-origin' })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          setFiles((fs) => fs.filter((f) => f.key !== key));
          insertPaths([d.rel || d.path]);
        })
        .catch((e) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: e.message } : f))));
    }
  };
  const uploading = files.some((f) => !f.error);
  const hint = !text.trim() && !uploading ? props.suggestion || '' : '';
  // screenshots pasted into the box are uploaded too
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return;
    e.preventDefault();
    keepCaret();
    upload(pasted);
  };

  // optimistic: clear the box and show the message at once, the request runs behind it
  const send = async () => {
    const msg = text.trim() ? text : hint;
    if (!msg.trim() || sending || uploading) return;
    setSending(true);
    setErr('');
    update('');
    // slash commands don't show up as chat messages: no placeholder bubble for them
    // /commands and !shell lines never show up as a message of yours in the log
    const isCommand = /^\s*[/!]/.test(msg);
    const done = isCommand ? () => {} : onPending(msg);
    try {
      await api('POST', `/_tw/api/sessions/${sessionId}/input`, { text: msg });
      done(true);
      // menus like /model or /usage are operated in the TUI itself
      if (props.slash && isInteractive(msg)) props.onInteractive?.();
    } catch (e: any) {
      done(false);
      setErr(e.message);
      // give the text back unless something new was typed meanwhile
      setText((cur) => {
        const restored = cur ? cur : msg;
        store.set(draftKey, restored || null);
        return restored;
      });
    } finally {
      setSending(false);
    }
  };

  const key = (keys: string[]) => api('POST', `/_tw/api/sessions/${sessionId}/keys`, { keys }).catch((e) => setErr(e.message));
  // interrupt what the agent is doing: Esc for Claude Code / Codex, Ctrl+C in a shell
  // only while working: while it waits for a choice, Esc would cancel the question instead
  const running = status === 'busy';
  const stop = () => key(props.agent === 'bash' ? ['C-c'] : ['Escape']);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && running && !e.isComposing) {
      e.preventDefault();
      stop();
      return;
    }
    // Tab (or → at the start) takes the suggestion into the box to edit it
    if (hint && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      update(hint);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !coarse) {
      e.preventDefault();
      send();
    }
  };

  // "/mo" → suggestions; only while the box holds a single command word
  const slashMatch = props.slash ? /^\/([\w-]*)$/.exec(text) : null;
  const suggestions = slashMatch ? SLASH.filter(([c]) => c.startsWith('/' + slashMatch[1])).slice(0, 8) : [];

  return (
    <div class="composer">
      {suggestions.length > 0 && (
        <div class="slash-list">
          {suggestions.map(([cmd, desc, interactive]) => (
            <button
              key={cmd}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                update(cmd + (interactive ? '' : ' '));
                ta.current?.focus();
              }}
            >
              <b>{cmd}</b>
              <span class="dim">{desc}</span>
              {interactive && <span class="tag">菜单</span>}
            </button>
          ))}
        </div>
      )}
      {keysOpen && (
        <div class="keys">
          {QUICK_KEYS.map(([label, keys, title]) => (
            <button key={label} title={title} class={status === 'waiting' && /^\d$/.test(label) ? 'hot' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => key(keys)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {err && <div class="error small">{err}</div>}
      {files.length > 0 && (
        <div class="attachments">
          {files.map((f) => (
            <span key={f.key} class={`att ${f.error ? 'err' : 'busy'}`} title={f.error || '上传中，完成后路径会插入输入框'}>
              {f.error ? '⚠' : <span class="spinner small-spin" />}
              <span class="att-name">{f.name}</span>
              <button aria-label="移除" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="input-row">
        {coarse && (
          <button class={`icon-btn ${keysOpen ? 'on' : ''}`} aria-label="快捷键" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowKeys((v) => !v)}>
            <Icon.keys />
          </button>
        )}
        {props.agent !== 'bash' && (
          <>
            <button
              class="icon-btn attach"
              aria-label="添加文件"
              title="插入文件路径：服务器上的文件，或从本机上传（也可以直接粘贴截图）"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                keepCaret();
                setAttachMenu(true);
              }}
            >
              <Icon.clip />
            </button>
            {attachMenu && (
              <Modal title="添加文件" onClose={() => setAttachMenu(false)}>
                <p class="dim small">选中的文件会以路径插入输入框的光标处。</p>
                <div class="sheet-list">
                  <button onClick={() => (setAttachMenu(false), setPicker(true))}>
                    服务器上的文件<span class="check dim">选文件或文件夹</span>
                  </button>
                  <button onClick={() => (setAttachMenu(false), fileInput.current?.click())}>
                    从本机上传<span class="check dim">图片、文档等</span>
                  </button>
                </div>
              </Modal>
            )}
            {picker && (
              <Modal title="选择文件" class="picker" onClose={() => setPicker(false)}>
                <FilesView
                  target={{
                    api: `/_tw/api/sessions/${sessionId}`,
                    key: `pick${sessionId}`,
                    global: false,
                    onPick: (p) => {
                      setPicker(false);
                      insertPaths([p]);
                    },
                  }}
                />
              </Modal>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const el = e.target as HTMLInputElement;
                if (el.files?.length) upload(el.files);
                el.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={ta}
          rows={1}
          onPaste={onPaste}
          value={text}
          class={hint ? 'has-hint' : ''}
          placeholder={hint ? (coarse ? hint : `${hint}　（Enter 发送这条建议，Tab 填入修改）`) : coarse ? '输入消息' : '输入消息，Enter 发送，Shift+Enter 换行'}
          onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        {running && (
          <button class={`stop ${coarse ? 'round' : ''}`} aria-label="停止" title="停止当前输出（Esc）" onMouseDown={(e) => e.preventDefault()} onClick={stop}>
            <span class="stop-square" />
            {!coarse && '停止'}
          </button>
        )}
        <button class={`primary send ${coarse ? 'round' : ''}`} aria-label="发送" onMouseDown={(e) => e.preventDefault()} onClick={send} disabled={sending || uploading || (!text.trim() && !hint)}>
          {sending ? '…' : coarse ? <Icon.send /> : '发送'}
        </button>
      </div>
    </div>
  );
}
