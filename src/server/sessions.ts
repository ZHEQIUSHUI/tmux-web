import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, groupIdsOf, q, type Agent, type HostRow, type SessionRow, type Share, type UserRow } from './db.js';
import { TmuxBackend } from './backend/tmux.js';
import type { PaneStream, PaneTarget, SessionBackend } from './backend/types.js';
import { getHost, shq, type Host } from './host.js';
import { Screen, type AgentStatus, type Choices } from './screen.js';
import { claudeTranscript, findCodexRollout } from './transcript.js';

export const backend: SessionBackend = new TmuxBackend();

const tmuxName = (id: number) => `tw-${id}`;

const INSTALL_HINT: Record<string, string[]> = {
  claude: ['未找到 claude。可以在下面的 shell 里安装：', '  curl -fsSL https://claude.ai/install.sh | bash', '装好后在会话设置里点「重启」。'],
  codex: ['未找到 codex。可以在下面的 shell 里安装：', '  npm install -g @openai/codex', '装好后在会话设置里点「重启」。'],
};

/**
 * The pane's command. It runs in a login shell so the agent sees the same PATH and environment
 * as an interactive login on the host; when the agent exits, a shell stays in the pane.
 */
function agentCommand(row: SessionRow, resume: boolean, fork = false): string {
  const extra = row.args.trim() ? ' ' + row.args.trim() : '';
  let cmd = '';
  if (row.agent === 'claude') {
    const id = row.agent_session_id!;
    // fork: continue a copy of a conversation that is still running elsewhere
    const resumeCmd = `claude --resume ${id}${fork ? ' --fork-session' : ''}${extra}`;
    cmd = resume
      ? `if ls "$HOME"/.claude/projects/*/${id}.jsonl >/dev/null 2>&1; then ${resumeCmd}; else claude --session-id ${id}${extra}; fi`
      : `claude --session-id ${id}${extra}`;
  } else if (row.agent === 'codex') {
    cmd = resume && row.agent_session_id ? `codex resume ${row.agent_session_id}${extra}` : `codex${extra}`;
  }
  if (cmd) cmd = `if command -v ${row.agent} >/dev/null; then ${cmd}; else printf '%s\\n' ${INSTALL_HINT[row.agent].map(shq).join(' ')}; fi; `;
  return `exec bash -lc ${shq(`export LANG="\${LANG:-C.UTF-8}"; ${cmd}exec bash -l`)}`;
}

function paneOf(row: SessionRow, host: Host): PaneTarget {
  return { name: row.tmux_name ?? tmuxName(row.id), socket: row.tmux_socket ?? config.tmuxSocket, host };
}

class HostDown extends Error {}

async function readyHost(id: number): Promise<Host> {
  const host = getHost(id);
  if (!host) throw new HostDown('主机已被删除');
  const st = await host.ready();
  if (!st.ok) throw new HostDown(st.error || '主机不可用');
  return host;
}

/** How long a busy agent's screen may stay still before a missing busy marker counts as idle. */
const STILL_BUSY_MS = 5000;

/** Runtime state of one session: control-mode stream, mirrored screen, derived status. */
export class LiveSession extends EventEmitter {
  status: AgentStatus = 'starting';
  preview = '';
  /** Claude Code permission mode read from its footer ('' when not shown / not claude) */
  mode = '';
  /** Claude Code says an update is installed and waits for a restart */
  update = false;
  /** background work shown in Claude Code's footer, e.g. "1 shell, 1 monitor" ('' = none) */
  background = '';
  /** the numbered menu on screen while waiting for a decision */
  choices: Choices | null = null;
  /** Claude Code's suggested next message (dim in its input box), '' if none */
  suggestion = '';
  /** when something last happened: the agent's log changed (or, for a shell, the screen did) */
  activityAt = 0;
  /** the conversation's title (Claude Code: /rename, agent name or the generated title) */
  title = '';
  /** activity time the title was last read at */
  titleAt = 0;
  /** log size at the last activity check */
  logSize = 0;
  error = '';
  screen: Screen | null = null;
  private stream: PaneStream | null = null;
  private analyzeTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  /** when the screen last changed */
  private outputAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(public row: SessionRow) {
    super();
    this.setMaxListeners(100);
  }

  get host(): Host | null {
    return getHost(this.row.host_id);
  }

  get target(): PaneTarget {
    return paneOf(this.row, this.host!);
  }

  /** An existing tmux session we attached to: its size and lifetime stay the user's. */
  get adopted() {
    return !!this.row.adopted;
  }

  /** Attach to the tmux session, (re)creating it if needed. */
  start(resume: boolean, fork = false): Promise<void> {
    this.stopped = false;
    this.starting ??= this.doStart(resume, fork).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(resume: boolean, fork = false) {
    if (this.stream) return;
    try {
      const host = await readyHost(this.row.host_id);
      let t = paneOf(this.row, host);
      if (!(await backend.has(t)) && this.row.adopted) {
        // the adopted tmux session is gone (e.g. host rebooted): continue it as one of ours
        q.unadopt.run(this.row.id);
        this.row = q.sessionById.get(this.row.id)!;
        t = paneOf(this.row, host);
        resume = true;
        hub.emit('list');
      }
      if (!(await backend.has(t))) {
        await backend.create(t, {
          cwd: this.row.cwd,
          command: agentCommand(this.row, resume, fork),
          cols: config.defaultCols,
          rows: config.defaultRows,
          term: host.status.term || 'screen-256color',
        });
      }
      this.retries = 0;
      this.error = '';
      this.attach(t);
    } catch (e: any) {
      // host unreachable: show it and keep trying in the background
      if (e instanceof HostDown || e.ssh) {
        this.error = e.message;
        this.setStatus('offline', '');
        this.scheduleRetry();
        return;
      }
      throw e;
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(60000, 3000 * 2 ** this.retries++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start(true).catch((e) => {
        this.error = e.message;
        this.setStatus('dead', '');
      });
    }, delay);
  }

  private attach(t: PaneTarget) {
    const stream = backend.stream(t);
    const screen = new Screen(config.defaultCols, config.defaultRows);
    const early: Buffer[] = [];
    let seeded = false;
    stream.on('data', (buf: Buffer) => {
      if (!seeded) return void early.push(buf);
      screen.write(buf);
      this.outputAt = Date.now();
      this.emit('data', buf);
      this.scheduleAnalyze();
      // a shell has no log: its screen is the activity (agents: see pollActivity)
      if (this.row.agent === 'bash') this.touch(Date.now());
    });
    // someone resized the window (e.g. the user's own terminal on an adopted session): follow it
    stream.on('layout', () => {
      backend
        .capture(t)
        .then((cap) => {
          if (this.screen !== screen || (cap.cols === screen.cols && cap.rows === screen.rows)) return;
          screen.resize(cap.cols, cap.rows);
          this.emit('size', cap.cols, cap.rows);
        })
        .catch(() => {});
    });
    stream.on('exit', () => {
      if (this.stream !== stream) return;
      this.stream = null;
      this.screen?.dispose();
      this.screen = null;
      this.emit('exit');
      if (!this.stopped) this.onStreamLost(t);
    });
    this.stream = stream;
    this.screen = screen;
    backend
      .capture(t)
      .then((cap) => {
        screen.seed(cap);
        for (const b of early) screen.write(b);
      })
      .catch(() => {})
      .finally(() => {
        seeded = true;
        this.scheduleAnalyze();
      });
  }

  /** The control client went away: the session ended, or only the connection to the host did. */
  private async onStreamLost(t: PaneTarget) {
    try {
      if (await backend.has(t)) {
        // connection dropped but tmux is still running there: reattach
        this.setStatus('starting', '');
        this.scheduleRetry();
      } else {
        this.setStatus('dead', '');
      }
    } catch (e: any) {
      this.error = e.message;
      this.setStatus('offline', '');
      this.scheduleRetry();
    }
  }

  private scheduleAnalyze() {
    if (this.analyzeTimer) return;
    this.analyzeTimer = setTimeout(async () => {
      this.analyzeTimer = null;
      if (!this.screen) return;
      await this.screen.flush();
      if (!this.screen) return;
      const { status, preview, mode, update, background, choices, suggestion: suggested } = this.screen.analyze();
      // a turn that is still held busy (holdBusy) has no suggestion yet
      const st = this.holdBusy(status);
      const suggestion = st === 'idle' ? suggested : '';
      const choicesKey = JSON.stringify(choices);
      if (mode !== this.mode || update !== this.update || background !== this.background || choicesKey !== JSON.stringify(this.choices) || suggestion !== this.suggestion) {
        this.suggestion = suggestion;
        this.mode = mode;
        this.update = update;
        this.background = background;
        this.choices = choices;
        this.emit('state', this.stateView());
      }
      this.setStatus(st, preview);
    }, 250);
  }

  /**
   * A narrow window cuts "esc to interrupt" off Claude Code's footer, and a long reply can push the
   * spinner off screen: while the screen keeps changing, a turn that was running still is.
   */
  private holdBusy(status: AgentStatus): AgentStatus {
    if (status !== 'idle' || this.status !== 'busy') return status;
    const quiet = Date.now() - this.outputAt;
    if (quiet >= STILL_BUSY_MS) return status;
    if (!this.recheckTimer)
      this.recheckTimer = setTimeout(() => {
        this.recheckTimer = null;
        this.scheduleAnalyze();
      }, STILL_BUSY_MS - quiet + 50).unref();
    return 'busy';
  }

  private setStatus(status: AgentStatus, preview: string) {
    const changed = status !== this.status;
    const previewChanged = preview !== this.preview;
    this.status = status;
    this.preview = preview;
    if (changed) {
      this.emit('status', status);
      hub.emit('status', this.row.id, status);
    }
    if (changed || previewChanged) this.emit('state', this.stateView());
  }

  /** Record activity; tell the sidebars when it moves noticeably. */
  touch(at: number) {
    if (at <= this.activityAt) return;
    const notable = at - this.activityAt > 5000;
    this.activityAt = at;
    if (notable) hub.emit('activity', this.row.id, at);
  }

  stateView() {
    return { status: this.status, preview: this.preview, error: this.error, mode: this.mode, update: this.update, background: this.background, choices: this.choices, suggestion: this.suggestion };
  }

  /**
   * Restart only the claude process in the pane (e.g. after an update), keeping the tmux session
   * and the conversation: stop it, then run `claude --resume <current conversation>` with the
   * same options in the shell it leaves behind.
   */
  async restartAgent(force = false): Promise<void> {
    if (this.row.agent !== 'claude') throw new Error('只有 Claude 会话支持');
    // restarting ends Claude's background shells and monitors: only when asked to explicitly
    if (this.background && !force) throw Object.assign(new Error(`Claude 有后台任务在运行（${this.background}），重启会结束它们`), { code: 'BACKGROUND' });
    const host = this.host;
    if (!host || !this.stream) throw new Error('会话未连接');
    const t = this.target;
    const out = await host.shText(
      `pp=$(tmux -u -L "$1" display-message -p -t "=$2:" '#{pane_pid}') || exit 3; ` +
        `cp=; for p in $pp $(pgrep -P "$pp" 2>/dev/null); do [ "$(ps -o comm= -p "$p" 2>/dev/null)" = claude ] && { cp=$p; break; }; done; ` +
        `[ -n "$cp" ] || { echo NOCLAUDE; exit 0; }; ` +
        `sid=$(sed -n 's/.*"sessionId" *: *"\\([0-9a-f-]*\\)".*/\\1/p' "$HOME/.claude/sessions/$cp.json" 2>/dev/null | head -n1); ` +
        `printf 'SID %s\\n' "$sid"; ` +
        // the original argv, one per line (Linux /proc; elsewhere fall back to ps)
        `if [ -r /proc/$cp/cmdline ]; then tr '\\0' '\\n' < /proc/$cp/cmdline; else ps -o args= -p "$cp" | tr ' ' '\\n'; fi; ` +
        `kill -TERM "$cp"; i=0; while kill -0 "$cp" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.2; i=$((i+1)); done; ` +
        `kill -0 "$cp" 2>/dev/null && kill -KILL "$cp"; true`,
      [t.socket, t.name],
    );
    if (out.startsWith('NOCLAUDE')) throw new Error('窗格里没有在运行的 claude');
    const [sidLine, , ...argv] = out.split('\n').filter((l, i) => i === 0 || l !== '');
    const sid = sidLine.replace(/^SID\s*/, '').trim() || this.row.agent_session_id;
    // keep the user's options, drop the ones that pick a conversation
    const keep: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--resume' || a === '-r' || a === '--session-id') {
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) i++;
        continue;
      }
      if (a === '--continue' || a === '-c' || a === '--fork-session' || a.startsWith('--resume=') || a.startsWith('--session-id=')) continue;
      keep.push(a);
    }
    // a conversation without any message yet has no log, and --resume would fail on it
    const hasLog = sid ? !!(await claudeTranscript(host, sid).catch(() => null)) : false;
    const pick = sid ? (hasLog ? ['--resume', sid] : ['--session-id', sid]) : [];
    const cmd = ['claude', ...pick, ...keep].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shq(a))).join(' ');
    if (sid && sid !== this.row.agent_session_id) {
      q.setTranscript.run(sid, null, this.row.id);
      this.row.agent_session_id = sid;
      this.row.transcript_path = null;
    }
    // give the shell a moment to come back to its prompt, then type the command
    await new Promise((r) => setTimeout(r, 400));
    await backend.keys(t, ['C-u']);
    this.write(cmd + '\r');
    this.update = false;
    this.emit('state', this.stateView());
    // answer once Claude is back (its input box, or a question it asks on start), so the page's
    // "重启中…" ends when it is really ready; a slow start just ends the wait
    const until = Date.now() + 25_000;
    await new Promise((r) => setTimeout(r, 800));
    while (Date.now() < until) {
      await this.screen?.flush();
      if (!this.screen || this.screen.claudeReady(cmd.slice(0, 40)) || this.status === 'waiting') break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  get alive() {
    return !!this.stream;
  }

  /**
   * Before typing into Claude Code from the web page: if its input box already holds text
   * (a half-typed draft, or a prompt an interrupt put back), clear it so ours isn't appended.
   * Esc twice clears a non-empty box (it never exits Claude; on an empty box it would open
   * /rewind, which is why we check first). Not while it is working or showing a menu.
   */
  async clearPromptInput(): Promise<void> {
    if (this.row.agent !== 'claude' || !this.screen || this.status === 'busy' || this.status === 'waiting') return;
    await this.screen.flush();
    if (!this.screen?.hasPromptInput()) return;
    const t = this.target;
    await backend.keys(t, ['Escape']);
    await new Promise((r) => setTimeout(r, 120));
    await backend.keys(t, ['Escape']);
    await new Promise((r) => setTimeout(r, 150));
  }

  write(data: string | Buffer) {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.stream || !this.screen || this.adopted) return;
    this.stream.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  /**
   * Claude Code switches to a new session id on /clear and some resumes. Ask the claude process
   * in the pane which conversation it is on (~/.claude/sessions/<pid>.json) and follow it.
   */
  async syncClaudeSession(): Promise<void> {
    const r = this.row;
    const host = this.host;
    if (r.agent !== 'claude' || !host || !this.stream) return;
    const t = this.target;
    const id = (
      await host
        .shText(
          `pp=$(tmux -L "$1" display-message -p -t "=$2:" '#{pane_pid}' 2>/dev/null) || exit 0; ` +
            `for p in $pp $(pgrep -P "$pp" 2>/dev/null); do f="$HOME/.claude/sessions/$p.json"; ` +
            `[ -f "$f" ] && { sed -n 's/.*"sessionId" *: *"\\([0-9a-f-]*\\)".*/\\1/p' "$f" | head -n1; exit 0; }; done`,
          [t.socket, t.name],
        )
        .catch(() => '')
    ).trim();
    // switch only once the new conversation has a log (a fresh fork writes it with its first message)
    if (id && /^[0-9a-f-]{36}$/.test(id) && id !== r.agent_session_id && (await claudeTranscript(host, id).catch(() => null))) {
      q.setTranscript.run(id, null, r.id);
      r.agent_session_id = id;
      r.transcript_path = null;
    }
  }

  /** Path of the agent's JSONL log on the host, once the agent has written it. */
  async transcriptPath(): Promise<string | null> {
    const r = this.row;
    if (r.transcript_path) return r.transcript_path;
    const host = this.host;
    if (!host) return null;
    let found: { id: string; file: string } | null = null;
    if (r.agent === 'claude' && r.agent_session_id) {
      const file = await claudeTranscript(host, r.agent_session_id);
      if (file) found = { id: r.agent_session_id, file };
    } else if (r.agent === 'codex') {
      const claimed = new Set(q.sessions.all().map((s) => s.transcript_path).filter((p): p is string => !!p));
      found = await findCodexRollout(host, r.cwd, r.created_at, claimed);
    }
    if (!found) return null;
    q.setTranscript.run(found.id, found.file, r.id);
    r.agent_session_id = found.id;
    r.transcript_path = found.file;
    return found.file;
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stream?.close();
    this.stream = null;
    this.screen?.dispose();
    this.screen = null;
  }
}

/** Broadcasts list/status changes to the sidebar streams. events: 'list', 'status' (id, status) */
export const hub = new EventEmitter();
hub.setMaxListeners(1000);

const live = new Map<number, LiveSession>();

export function getLive(id: number): LiveSession | undefined {
  return live.get(id);
}

// ---------- access control ----------

export type Access = 'none' | 'view' | 'control';

export function accessOf(user: UserRow, row: SessionRow, groups = groupIdsOf(user.id)): Access {
  if (user.role === 'admin' || row.owner_id === user.id) return 'control';
  if (row.group_id !== null && row.share !== 'none' && groups.includes(row.group_id)) return row.share;
  return 'none';
}

export function canUseHost(user: UserRow, h: HostRow): boolean {
  return user.role === 'admin' || h.owner_id === null || h.owner_id === user.id;
}

export function sessionView(user: UserRow) {
  const groups = groupIdsOf(user.id);
  const folderOf = new Map(q.folderAssignments.all(user.id).map((a) => [a.session_id, a.folder_id]));
  const owners = new Map(q.users.all().map((u) => [u.id, u.username]));
  const hostNames = new Map(q.hosts.all().map((h) => [h.id, h.name]));
  return q.sessions
    .all()
    .map((row) => ({ row, access: accessOf(user, row, groups) }))
    .filter((x) => x.access !== 'none')
    .map(({ row, access }) => ({
      id: row.id,
      name: row.name,
      agent: row.agent,
      cwd: row.cwd,
      hostId: row.host_id,
      host: hostNames.get(row.host_id) ?? '?',
      owner: owners.get(row.owner_id) ?? '?',
      groupId: row.group_id,
      share: row.share,
      adopted: !!row.adopted,
      note: row.note,
      folderId: folderOf.get(row.id) ?? null,
      tmux: row.adopted ? `${row.tmux_socket === 'default' ? '' : `-L ${row.tmux_socket} `}${row.tmux_name}` : null,
      access,
      status: live.get(row.id)?.status ?? 'dead',
      activityAt: live.get(row.id)?.activityAt || row.created_at,
      title: live.get(row.id)?.title || '',
    }));
}

// ---------- lifecycle ----------

// ---------- activity ----------

/** A Claude Code conversation's title: a /rename wins over the agent name and the generated one. */
async function claudeTitle(host: Host, file: string): Promise<string> {
  const out = await host.shText(
    `{ head -c 262144 -- "$1"; printf '\\n'; tail -c 262144 -- "$1"; } | grep -o '"\\(customTitle\\|agentName\\|aiTitle\\)":"\\([^"\\\\]\\|\\\\.\\)\\{0,200\\}"'`,
    [file],
  );
  const last: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^"(\w+)":"(.*)"$/.exec(line);
    if (m) last[m[1]] = jsonUnescape(m[2]).trim();
  }
  return last.customTitle || last.agentName || last.aiTitle || '';
}

const ACTIVITY_EVERY_MS = 10_000;

/**
 * Every few seconds, one command per host stats the agents' logs: their modification time is
 * when the session last did something (a reply, a tool call, your message).
 */
async function pollActivity() {
  const byHost = new Map<number, LiveSession[]>();
  for (const s of live.values()) {
    if (s.row.agent === 'bash' || !s.host) continue;
    if (!s.row.transcript_path) await s.transcriptPath().catch(() => null);
    if (!s.row.transcript_path) continue;
    byHost.set(s.row.host_id, [...(byHost.get(s.row.host_id) ?? []), s]);
  }
  for (const [hostId, list] of byHost) {
    const host = getHost(hostId);
    if (!host?.status.ok) continue;
    try {
      // the size tells whether the log grew (its mtime also moves when Claude Code merely
      // touches the file); when it did, the last record's own timestamp is the activity time
      const out = await host.shText(`for f; do stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f" 2>/dev/null || echo 0; done`, list.map((s) => s.row.transcript_path!));
      const sizes = out.trim().split('\n').map(Number);
      for (let i = 0; i < list.length; i++) {
        const sess = list[i];
        if (!sizes[i] || sizes[i] === sess.logSize) continue;
        sess.logSize = sizes[i];
        const ts = (
          await host
            .shText(`tail -c 65536 -- "$1" | grep -o '"timestamp":"[^"]*"' | tail -n 1`, [sess.row.transcript_path!])
            .catch(() => '')
        ).trim();
        const at = Date.parse(ts.replace(/^"timestamp":"|"$/g, ''));
        if (at) sess.touch(at);
      }
      // titles change rarely: re-read only for sessions whose log moved since
      for (const sess of list) {
        if (sess.row.agent !== 'claude' || sess.titleAt >= sess.activityAt) continue;
        sess.titleAt = sess.activityAt;
        const title = await claudeTitle(host, sess.row.transcript_path!).catch(() => sess.title);
        if (title !== sess.title) {
          sess.title = title;
          hub.emit('list');
        }
      }
    } catch {
      /* host hiccup: next round */
    }
  }
}
setInterval(() => pollActivity().catch(() => {}), ACTIVITY_EVERY_MS).unref();
setTimeout(() => pollActivity().catch(() => {}), 2000).unref();

/** At boot: attach to every session, recreating (and resuming) the ones whose tmux is gone. */
export async function restoreAll() {
  for (const row of q.sessions.all()) {
    const s = new LiveSession(row);
    live.set(row.id, s);
    s.start(true).catch((e) => {
      console.error(`session ${row.id} failed to start:`, e.message);
      s.error = e.message;
      s.status = 'dead';
    });
  }
}

/**
 * Create the working directory on the host and return its absolute path.
 * `~` and relative paths are relative to the host user's home.
 */
async function prepareCwd(host: Host, cwd: string): Promise<string> {
  const out = await host.shText(`p=$1; case $p in "~") p=$HOME;; "~/"*) p="$HOME/\${p#\\~/}";; esac; cd "$HOME" && mkdir -p -- "$p" && cd -- "$p" && pwd -P`, [cwd]);
  return out.trim();
}

export async function createSession(
  owner: UserRow,
  input: { name: string; agent: Agent; hostId: number; cwd: string; args: string; groupId: number | null; share: Share; resumeId?: string; fork?: boolean },
) {
  const host = await readyHost(input.hostId).catch((e) => {
    throw new Error(`主机不可用：${e.message}`);
  });
  if (input.resumeId && !input.fork) {
    // two claude processes on one conversation would interleave its log
    const running = (await claudeHistory(host, 200)).find((h) => h.id === input.resumeId)?.running;
    if (running) throw new Error(`这个会话正在${running.tmux ? ` tmux「${running.tmux}」` : '别处'}运行，请选择「复制一份继续」，或直接导入那个 tmux 会话`);
  }
  const cwd = await prepareCwd(host, input.cwd || '~');
  const agentSessionId = input.agent === 'claude' ? input.resumeId || crypto.randomUUID() : null;
  const name = input.name || `${input.agent} ${cwd.split('/').pop() || '~'}`;
  const info = q.insertSession.run(name, owner.id, input.groupId, input.share, input.agent, agentSessionId, cwd, input.args, input.hostId, Date.now());
  const row = q.sessionById.get(Number(info.lastInsertRowid))!;
  const s = new LiveSession(row);
  live.set(row.id, s);
  try {
    await s.start(!!input.resumeId, !!input.fork);
  } catch (e) {
    live.delete(row.id);
    q.deleteSession.run(row.id);
    throw e;
  }
  hub.emit('list');
  return row;
}

export async function restartSession(id: number) {
  const s = live.get(id);
  if (!s) return;
  s.stop();
  if (s.host) await backend.kill(s.target).catch(() => {});
  s.row = q.sessionById.get(id)!;
  await s.start(true);
  hub.emit('list');
}

export async function deleteSession(id: number) {
  const s = live.get(id);
  if (s) {
    s.stop();
    // an adopted session belongs to the user's own tmux: just stop watching it
    if (s.host && !s.adopted) await backend.kill(s.target).catch(() => {});
    live.delete(id);
  }
  q.deleteSession.run(id);
  hub.emit('list');
}

export function updateSession(id: number, patch: { name?: string; groupId?: number | null; share?: Share }) {
  const row = q.sessionById.get(id);
  if (!row) return;
  const name = patch.name ?? row.name;
  const groupId = patch.groupId === undefined ? row.group_id : patch.groupId;
  const share = patch.share ?? row.share;
  db.prepare('update sessions set name = ?, group_id = ?, share = ? where id = ?').run(name, groupId, share, id);
  const s = live.get(id);
  if (s) s.row = q.sessionById.get(id)!;
  hub.emit('list');
}

export async function deleteSessionsOf(userId: number) {
  for (const row of q.sessions.all().filter((r) => r.owner_id === userId)) await deleteSession(row.id);
}

// ---------- adopting existing tmux sessions ----------

export interface ExistingTmux {
  socket: string;
  name: string;
  cwd: string;
  command: string;
  agent: Agent;
  /** Claude Code conversation running in it, if any */
  claudeSession?: string;
  attached: boolean;
  /** already shown in tmux-web */
  adoptedAs?: number;
}

/** The user's own tmux sessions on a host (default server), with what runs in them. */
export async function listExistingTmux(host: Host, socket = 'default'): Promise<ExistingTmux[]> {
  const out = await host.shText(
    `tmux -L "$1" list-panes -a -F '#{session_name}\t#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_attached}' 2>/dev/null | ` +
      `while IFS="$(printf '\t')" read -r s wp pp cmd cwd att; do ` +
      `[ "$wp" = "0.0" ] || continue; sid=; for p in $pp $(pgrep -P "$pp" 2>/dev/null); do f="$HOME/.claude/sessions/$p.json"; ` +
      `[ -f "$f" ] && sid=$(sed -n 's/.*"sessionId" *: *"\\([0-9a-f-]*\\)".*/\\1/p' "$f" | head -n1) && break; done; ` +
      `printf '%s\t%s\t%s\t%s\t%s\n' "$s" "$cmd" "$cwd" "$att" "$sid"; done`,
    [socket],
  );
  const adopted = new Map(
    q.sessions
      .all()
      .filter((r) => r.adopted && r.host_id === host.row.id)
      .map((r) => [`${r.tmux_socket}/${r.tmux_name}`, r.id]),
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, command, cwd, att, sid] = line.split('\t');
      const agent: Agent = sid || command === 'claude' ? 'claude' : command === 'codex' ? 'codex' : 'bash';
      return { socket, name, cwd, command, agent, claudeSession: sid || undefined, attached: att !== '0', adoptedAs: adopted.get(`${socket}/${name}`) };
    });
}

/** Show an existing tmux session in tmux-web without restarting anything in it. */
export async function adoptSession(owner: UserRow, host: Host, socket: string, name: string) {
  const found = (await listExistingTmux(host, socket)).find((e) => e.name === name);
  if (!found) throw new Error(`tmux 会话 ${name} 不存在`);
  if (found.adoptedAs) return q.sessionById.get(found.adoptedAs)!;
  const info = q.insertAdopted.run(name, owner.id, found.agent, found.claudeSession ?? null, found.cwd, host.row.id, socket, name, Date.now());
  const row = q.sessionById.get(Number(info.lastInsertRowid))!;
  const s = new LiveSession(row);
  live.set(row.id, s);
  await s.start(true);
  hub.emit('list');
  return row;
}

// ---------- Claude Code history ----------

export interface ClaudeHistory {
  id: string;
  cwd: string;
  title: string;
  lastPrompt: string;
  mtime: number;
  size: number;
  /** running in some claude process right now (its tmux pane if known) */
  running?: { tmux?: string };
  /** already open in tmux-web as this session */
  openAs?: number;
}

const HIST_FIELDS = /^"(aiTitle|customTitle|agentName|lastPrompt|cwd)":"(.*)$/;

function jsonUnescape(s: string): string {
  // values may be cut mid-escape by the length limit: drop a dangling backslash sequence
  for (let t = s; t; t = t.slice(0, -1)) {
    try {
      return JSON.parse(`"${t}"`);
    } catch {
      /* shorten and retry */
    }
  }
  return '';
}

/**
 * Recent Claude Code conversations on a host. Only the first and last 256KB of each log are read,
 * which is where titles, the working directory and the latest prompt are recorded.
 */
const historyCache = new Map<number, { at: number; list: Promise<ClaudeHistory[]> }>();

/**
 * Claude history with a short cache: reading many large logs takes seconds, and the list
 * barely changes between opening the dialog twice. A stale answer is returned at once while
 * a fresh one is fetched for next time.
 */
export function claudeHistoryCached(host: Host): Promise<ClaudeHistory[]> {
  const hit = historyCache.get(host.row.id);
  const refresh = () => {
    const list = claudeHistory(host);
    historyCache.set(host.row.id, { at: Date.now(), list });
    list.catch(() => historyCache.delete(host.row.id));
    return list;
  };
  if (!hit) return refresh();
  if (Date.now() - hit.at > 15_000) {
    // serve the previous result now, refresh behind it
    const prev = hit.list;
    refresh().catch(() => {});
    return prev;
  }
  return hit.list;
}

export async function claudeHistory(host: Host, limit = 60): Promise<ClaudeHistory[]> {
  const out = await host.shText(
    `cd "$HOME/.claude/projects" 2>/dev/null || exit 0; ` +
      `ls -t -- */*.jsonl 2>/dev/null | head -n "$1" | while IFS= read -r f; do ` +
      `printf '@\t%s\t%s\n' "$f" "$(stat -c '%Y %s' -- "$f" 2>/dev/null || stat -f '%m %z' -- "$f")"; ` +
      `{ head -c 262144 -- "$f"; printf '\\n'; tail -c 262144 -- "$f"; } | grep -o '"\\(aiTitle\\|customTitle\\|agentName\\|lastPrompt\\|cwd\\)":"\\([^"\\\\]\\|\\\\.\\)\\{0,240\\}'; ` +
      `done; ` +
      `for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] || continue; p=\${f##*/}; p=\${p%.json}; kill -0 "$p" 2>/dev/null || continue; ` +
      `printf 'R\\t%s\\t%s\\n' "$(sed -n 's/.*"sessionId" *: *"\\([0-9a-f-]*\\)".*/\\1/p' "$f" | head -n1)" "$(sed -n 's/.*"tmux" *: *"\\([^"]*\\)".*/\\1/p' "$f" | head -n1)"; done`,
    [String(limit)],
  );
  const list: ClaudeHistory[] = [];
  const running = new Map<string, { tmux?: string }>();
  let cur: (ClaudeHistory & { titles: Record<string, string> }) | null = null;
  const flush = () => {
    if (!cur) return;
    const t = cur.titles;
    cur.title = t.customTitle || t.agentName || t.aiTitle || '';
    const { titles: _, ...h } = cur;
    list.push(h);
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('@\t')) {
      flush();
      const [, file, stat] = line.split('\t');
      const [mtime, size] = (stat || '').split(' ').map(Number);
      const id = file.split('/').pop()!.replace(/\.jsonl$/, '');
      cur = { id, cwd: '', title: '', lastPrompt: '', mtime: mtime * 1000, size, titles: {} };
    } else if (line.startsWith('R\t')) {
      const [, id, tmux] = line.split('\t');
      // tmux is "session:@window.%pane"; the session name is what people know
      if (id) running.set(id, tmux ? { tmux: tmux.split(':')[0] } : {});
    } else if (cur) {
      const m = HIST_FIELDS.exec(line);
      if (!m) continue;
      const v = jsonUnescape(m[2]).replace(/\s+/g, ' ').trim();
      if (!v) continue;
      if (m[1] === 'cwd') cur.cwd = v; // the latest one: conversations can move with the project
      else if (m[1] === 'lastPrompt') cur.lastPrompt = v;
      else cur.titles[m[1]] = v; // later occurrences (renames) win
    }
  }
  flush();
  const open = new Map(
    q.sessions
      .all()
      .filter((r) => r.host_id === host.row.id && r.agent === 'claude' && r.agent_session_id)
      .map((r) => [r.agent_session_id!, r.id]),
  );
  for (const h of list) {
    if (running.has(h.id)) h.running = running.get(h.id);
    if (open.has(h.id)) h.openAs = open.get(h.id);
  }
  return list;
}

/** Directories offered when creating a session: the host user's home and what's under it. */
export async function suggestDirs(host: Host): Promise<string[]> {
  const out = await host.shText(
    `printf '%s\\n' "$HOME"; find "$HOME" -mindepth 1 -maxdepth 3 \\( -name '.*' -o -name node_modules -o -name __pycache__ -o -name venv \\) -prune -o -type d -print 2>/dev/null | head -n 400`,
  );
  const [home, ...dirs] = out.split('\n').filter(Boolean);
  return [home, ...dirs.sort()];
}
