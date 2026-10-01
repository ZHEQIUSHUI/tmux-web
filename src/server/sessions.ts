import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, groupIdsOf, q, type Agent, type HostRow, type SessionRow, type Share, type UserRow } from './db.js';
import { TmuxBackend } from './backend/tmux.js';
import type { PaneStream, PaneTarget, SessionBackend } from './backend/types.js';
import { getHost, shq, type Host } from './host.js';
import { Screen, type AgentStatus } from './screen.js';
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
function agentCommand(row: SessionRow, resume: boolean): string {
  const extra = row.args.trim() ? ' ' + row.args.trim() : '';
  let cmd = '';
  if (row.agent === 'claude') {
    const id = row.agent_session_id!;
    cmd = resume
      ? `if ls "$HOME"/.claude/projects/*/${id}.jsonl >/dev/null 2>&1; then claude --resume ${id}${extra}; else claude --session-id ${id}${extra}; fi`
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

/** Runtime state of one session: control-mode stream, mirrored screen, derived status. */
export class LiveSession extends EventEmitter {
  status: AgentStatus = 'starting';
  preview = '';
  error = '';
  screen: Screen | null = null;
  private stream: PaneStream | null = null;
  private analyzeTimer: NodeJS.Timeout | null = null;
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
  start(resume: boolean): Promise<void> {
    this.stopped = false;
    this.starting ??= this.doStart(resume).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(resume: boolean) {
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
          command: agentCommand(this.row, resume),
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
      this.emit('data', buf);
      this.scheduleAnalyze();
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
      const { status, preview } = this.screen.analyze();
      this.setStatus(status, preview);
    }, 250);
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
    if (changed || previewChanged) this.emit('state', { status, preview, error: this.error });
  }

  get alive() {
    return !!this.stream;
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
    if (id && /^[0-9a-f-]{36}$/.test(id) && id !== r.agent_session_id) {
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
      tmux: row.adopted ? `${row.tmux_socket === 'default' ? '' : `-L ${row.tmux_socket} `}${row.tmux_name}` : null,
      access,
      status: live.get(row.id)?.status ?? 'dead',
    }));
}

// ---------- lifecycle ----------

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

export async function createSession(owner: UserRow, input: { name: string; agent: Agent; hostId: number; cwd: string; args: string; groupId: number | null; share: Share }) {
  const host = await readyHost(input.hostId).catch((e) => {
    throw new Error(`主机不可用：${e.message}`);
  });
  const cwd = await prepareCwd(host, input.cwd || '~');
  const agentSessionId = input.agent === 'claude' ? crypto.randomUUID() : null;
  const name = input.name || `${input.agent} ${cwd.split('/').pop() || '~'}`;
  const info = q.insertSession.run(name, owner.id, input.groupId, input.share, input.agent, agentSessionId, cwd, input.args, input.hostId, Date.now());
  const row = q.sessionById.get(Number(info.lastInsertRowid))!;
  const s = new LiveSession(row);
  live.set(row.id, s);
  try {
    await s.start(false);
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

/** Directories offered when creating a session: the host user's home and what's under it. */
export async function suggestDirs(host: Host): Promise<string[]> {
  const out = await host.shText(
    `printf '%s\\n' "$HOME"; find "$HOME" -mindepth 1 -maxdepth 3 \\( -name '.*' -o -name node_modules -o -name __pycache__ -o -name venv \\) -prune -o -type d -print 2>/dev/null | head -n 400`,
  );
  const [home, ...dirs] = out.split('\n').filter(Boolean);
  return [home, ...dirs.sort()];
}
