import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type ChatItem, type Folder, type Group, type HostInfo, type Notice, type Me, type Page, type SessionInfo, type Status } from './api';
import { renderMarkdown } from './markdown';
import './style.css';

const STATUS_LABEL: Record<Status, string> = { starting: '连接中', idle: '空闲', busy: '运行中', waiting: '等待确认', offline: '主机离线', dead: '已停止' };
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', bash: 'Shell' } as const;

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const coarsePointer = matchMedia('(pointer: coarse)').matches;

/**
 * EventSource that survives phones: the browser gives up on some errors, and after a phone
 * sleeps a stream can look open while being dead. Reopen when closed, when the server's
 * heartbeat stops arriving, and whenever the page becomes visible or the network comes back.
 */
function liveStream(url: () => string, handlers: Record<string, (data: any, ev: MessageEvent) => void>, onLink?: (ok: boolean) => void) {
  let es: EventSource | null = null;
  let closed = false;
  let last = Date.now();
  let retry = 0;
  let timer = 0;
  const open = () => {
    if (closed) return;
    es?.close();
    const cur = new EventSource(url());
    es = cur;
    last = Date.now();
    for (const [name, fn] of Object.entries(handlers))
      cur.addEventListener(name, (ev) => {
        last = Date.now();
        fn(JSON.parse((ev as MessageEvent).data), ev as MessageEvent);
      });
    cur.addEventListener('ping', () => (last = Date.now()));
    cur.onopen = () => {
      retry = 0;
      last = Date.now();
      onLink?.(true);
    };
    cur.onerror = () => {
      onLink?.(false);
      if (cur.readyState === EventSource.CLOSED) {
        clearTimeout(timer);
        timer = window.setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
      }
    };
  };
  const check = () => {
    if (closed || document.hidden) return;
    if (!es || es.readyState === EventSource.CLOSED || Date.now() - last > 50000) open();
  };
  const iv = window.setInterval(check, 10000);
  document.addEventListener('visibilitychange', check);
  addEventListener('online', check);
  open();
  return () => {
    closed = true;
    clearInterval(iv);
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', check);
    removeEventListener('online', check);
    es?.close();
  };
}

// ---------------- theme ----------------

type ThemePref = 'auto' | 'light' | 'dark';
const THEME_LABEL: Record<ThemePref, string> = { auto: '跟随系统', light: '浅色', dark: '深色' };
const darkMq = matchMedia('(prefers-color-scheme: dark)');

/** Apply a theme preference: data-theme on <html>, and the browser bar color on phones. */
function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'auto') delete root.dataset.theme;
  else root.dataset.theme = pref;
  const dark = pref === 'dark' || (pref === 'auto' && darkMq.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111317' : '#f6f6f4');
}
const savedTheme = (): ThemePref => (store.get('tw:theme') as ThemePref) || 'auto';
applyTheme(savedTheme());
darkMq.addEventListener('change', () => applyTheme(savedTheme()));

function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(savedTheme);
  return [
    pref,
    (t) => {
      store.set('tw:theme', t === 'auto' ? null : t);
      applyTheme(t);
      setPref(t);
    },
  ];
}

/** Compact cycling button for the desktop sidebar. */
function ThemeCycle() {
  const [pref, set] = useTheme();
  const next: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };
  const icon = { auto: '◐', light: '☀', dark: '☾' }[pref];
  return (
    <button class="ghost small" onClick={() => set(next[pref])} title={`外观：${THEME_LABEL[pref]}（点击切换）`}>
      {icon}
    </button>
  );
}

function ThemeSwitch() {
  const [pref, set] = useTheme();
  return (
    <div class="tabs theme-switch">
      {(['auto', 'light', 'dark'] as ThemePref[]).map((t) => (
        <button key={t} class={pref === t ? 'on' : ''} onClick={() => set(t)}>
          {THEME_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

/** Phone layout (list → session navigation) below this width. */
function useNarrow() {
  const mq = useMemo(() => matchMedia('(max-width: 760px)'), []);
  const [narrow, setNarrow] = useState(mq.matches);
  useEffect(() => {
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return narrow;
}

const Icon = {
  back: () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  chat: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  ),
  term: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  ),
  globe: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  ),
  more: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
  plus: () => (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  send: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  keys: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" stroke-linecap="round" />
    </svg>
  ),
  clip: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7L14 4.5a3.5 3.5 0 015 5L10.5 18a2 2 0 01-3-3L15 7.5" />
    </svg>
  ),
  folderPlus: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  ),
  user: () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" stroke-linecap="round" />
    </svg>
  ),
};

function useHashSession(): [number | null, (id: number | null) => void] {
  const read = () => {
    const m = /^#\/s\/(\d+)/.exec(location.hash);
    return m ? Number(m[1]) : null;
  };
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [id, (n) => (location.hash = n === null ? '' : `#/s/${n}`)];
}

// ---------------- login ----------------

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [shake, setShake] = useState(0);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setErr('');
    try {
      onLogin(await api<Me>('POST', '/_tw/api/login', { username: f.get('username'), password: f.get('password') }));
    } catch (e: any) {
      setErr(e.message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <div class="login-box">
        <img class="login-logo" src="/_tw/icon-192.png" alt="" width="64" height="64" />
        <h1>tmux-web</h1>
        <p class="login-sub">登录后管理你的 agent 会话</p>
        <form onSubmit={submit} class={`login-form ${shake ? 'shake' : ''}`} key={shake}>
          <input name="username" class="login-input" placeholder="账号" autocomplete="username" autocapitalize="off" spellcheck={false} required autoFocus={!coarsePointer} />
          <div class="login-pw">
            <input name="password" class="login-input" type={(show ? 'text' : 'password') as 'password'} placeholder="密码" autocomplete="current-password" required />
            <button type="button" class="login-eye" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏密码' : '显示密码'}>
              {show ? '隐藏' : '显示'}
            </button>
          </div>
          {err && <p class="login-err">{err}</p>}
          <button class="primary login-btn" disabled={busy}>
            {busy ? <span class="spinner" /> : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------- chat ----------------

function ToolGroup({ items, onExpand }: { items: ChatItem[]; onExpand: (it: ChatItem) => void }) {
  const last = items[items.length - 1];
  const calls = items.filter((i) => i.tool !== 'result' && i.tool !== 'error').length;
  const firstLine = (last.text.split('\n')[0] || '').slice(0, 90);
  return (
    <details class="tools">
      <summary>
        <span class="tool-badge">⚙ {calls || items.length}</span>
        <span class="tool-last">
          {last.tool && last.tool !== 'result' ? <b>{last.tool} </b> : null}
          {firstLine}
        </span>
      </summary>
      {items.map((it) => (
        <div key={it.id} class={`tool-line ${it.tool === 'error' ? 'err' : ''}`}>
          {it.tool && it.tool !== 'result' && it.tool !== 'error' ? <b>{it.tool}</b> : <span class="dim">↳</span>}
          <pre>{it.text}</pre>
          {it.truncated && (
            <button class="link" onClick={() => onExpand(it)}>
              展开全部
            </button>
          )}
        </div>
      ))}
    </details>
  );
}

const mdCache = new Map<string, string>();
function Markdown({ id, text }: { id: string; text: string }) {
  const key = id + ':' + text.length;
  let html = mdCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(text);
    if (mdCache.size > 500) mdCache.clear();
    mdCache.set(key, html);
  }
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Message({ it, onExpand, onRewind }: { it: ChatItem; onExpand: (it: ChatItem) => void; onRewind?: () => void }) {
  const [actions, setActions] = useState(false);
  const more = it.truncated && (
    <button class="link" onClick={() => onExpand(it)}>
      展开全文
    </button>
  );
  if (it.role === 'user')
    return (
      // tap (phones) or hover (desktop) shows what can be done with your own message
      <div class={`msg user ${actions ? 'show-actions' : ''}`} onClick={() => onRewind && setActions((v) => !v)}>
        <div class="bubble">
          {it.text}
          {more}
        </div>
        {onRewind && (
          <div class="msg-actions">
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
          </div>
        )}
      </div>
    );
  if (it.role === 'meta') return <div class="msg meta">{it.text}</div>;
  return (
    <div class="msg assistant">
      <Markdown id={it.id} text={it.text} />
      {more}
    </div>
  );
}

type Block = { kind: 'msg'; it: ChatItem } | { kind: 'tools'; items: ChatItem[] };
function groupItems(items: ChatItem[]): Block[] {
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

const QUICK_KEYS: [string, string[], string][] = [
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
const SLASH: [string, string, boolean][] = [
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
function isInteractive(text: string): boolean {
  const m = /^\s*(\/[\w-]+)\s*$/.exec(text);
  return !!m && SLASH.some(([c, , interactive]) => c === m[1] && interactive);
}

interface ClaudeState {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  permissionMode?: string;
  /** live permission mode from the TUI footer */
  mode?: string;
}

const MODE_LABEL: Record<string, string> = {
  auto: '自动模式',
  bypassPermissions: '跳过确认',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  default: '每次确认',
};

/** claude-opus-5-5 → Opus 5.5, claude-fable-5 → Fable 5 */
function modelName(id?: string): string {
  if (!id) return '';
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const name = parts.filter((p) => !/^\d+$/.test(p)).map((p) => p[0].toUpperCase() + p.slice(1));
  const ver = parts.filter((p) => /^\d+$/.test(p)).join('.');
  return [...name, ver].filter(Boolean).join(' ');
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Thin bar above the chat: model · permission mode · context used. Tap for the control sheet. */
function ClaudeBar({ st, update, onOpen, onRestart }: { st: ClaudeState | null; update: boolean; onOpen: () => void; onRestart?: () => void }) {
  // always rendered (fixed height) so the chat below doesn't jump when the data arrives
  st ||= {};
  const mode = st.mode || st.permissionMode || '';
  const pct = st.contextTokens && st.contextWindow ? Math.min(100, (st.contextTokens / st.contextWindow) * 100) : null;
  const level = pct === null ? '' : pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
  return (
    <div class="cbar">
      {update && onRestart && (
        <button class="cbar-update" onClick={onRestart} title="Claude Code 已更新，重启后生效（对话会接着继续）">
          有新版本 · 重启
        </button>
      )}
      <button class="cbar-main" onClick={onOpen} title="Claude 状态与设置">
      <span class="cbar-model">{modelName(st.model) || 'Claude'}</span>
      {!st.model && <span class="cbar-loading">读取状态…</span>}
      {mode && <span class={`cbar-mode ${mode}`}>{MODE_LABEL[mode] ?? mode}</span>}
      {pct !== null && (
        <span class="cbar-ctx">
          <span class="cbar-meter">
            <span class={`cbar-fill ${level}`} style={{ width: `${pct}%` }} />
          </span>
          上下文 {fmtTokens(st.contextTokens!)} / {fmtTokens(st.contextWindow!)}
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
function ClaudePanel(props: { st: ClaudeState | null; canControl: boolean; onClose: () => void; run: (cmd: string) => void; sendKeys: (k: string[]) => void; onRestart: () => void }) {
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

/** Restart only the claude process; asks first if it is in the middle of something. */
async function restartAgent(session: SessionInfo, status: Status): Promise<boolean> {
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
interface Pending {
  key: number;
  text: string;
  sent: boolean;
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What a chat view had, so coming back to a session shows it at once (and where you were). */
interface ChatCache {
  items: ChatItem[];
  page: { start: number; hasMore: boolean; pending: boolean };
  /** log offset the live stream continues from */
  end: number;
  at: number;
  /** null = was pinned to the bottom */
  scrollTop: number | null;
  claude: ClaudeState | null;
}
const chatCache = new Map<number, ChatCache>();
const CACHE_FRESH_MS = 30 * 60 * 1000;

function ChatView({ session, onOpenTerminal }: { session: SessionInfo; onOpenTerminal: () => void }) {
  const cached = useMemo(() => {
    const c = chatCache.get(session.id);
    return c && Date.now() - c.at < CACHE_FRESH_MS ? c : undefined;
  }, [session.id]);
  const [items, setItems] = useState<ChatItem[]>(cached?.items ?? []);
  const [claude, setClaude] = useState<ClaudeState | null>(cached?.claude ?? null);
  const [panel, setPanel] = useState(false);
  const [update, setUpdate] = useState(false);
  const isClaude = session.agent === 'claude';
  // shown right away when you press send; removed once the agent's log has the message
  const [pending, setPending] = useState<Pending[]>([]);
  const [page, setPage] = useState<{ start: number; hasMore: boolean; pending: boolean } | null>(cached?.page ?? null);
  const endRef = useRef(cached?.end ?? 0);
  const [state, setState] = useState<{ status: Status; preview: string; error?: string }>({ status: session.status, preview: '' });
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
          () => `/_tw/api/sessions/${id}/stream?from=${offset}`,
          {
            msg: (fresh: ChatItem[], ev) => {
              if (ev.lastEventId) offset = endRef.current = Number(ev.lastEventId);
              if (fresh.length) {
                setItems((cur) => {
                  const seen = new Set(cur.map((i) => i.id));
                  return [...cur, ...fresh.filter((i) => !seen.has(i.id))];
                });
                const arrived = fresh.filter((i) => i.role === 'user').map((i) => norm(i.text));
                if (arrived.length) setPending((ps) => ps.filter((p) => !arrived.some((a) => a === norm(p.text) || a.startsWith(norm(p.text).slice(0, 200)))));
              }
              setPage((pg) => (pg && pg.pending ? { ...pg, pending: false } : pg));
            },
            state: (st: { status: Status; preview: string; error?: string; mode?: string; update?: boolean }) => {
              setState(st);
              setUpdate(!!st.update);
              if (st.mode !== undefined) setClaude((c) => (c ? { ...c, mode: st.mode } : c));
            },
            reset: () => {
              chatCache.delete(id);
              setGeneration((g) => g + 1);
            },
          },
          setOnline,
        );
    };
    if (generation === 0 && cached) {
      // shown from the cache already: just continue the stream from where it was
      begin(cached.end);
    } else {
      setItems([]);
      setPage(null);
      stick.current = true;
      api<Page>('GET', `/_tw/api/sessions/${id}/messages?limit=30`)
        .then((p) => {
          if (cancelled) return;
          setItems(p.items);
          setPage({ start: p.start, hasMore: p.hasMore, pending: !!p.pending });
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
    chatCache.set(id, { items, page, end: endRef.current, at: Date.now(), scrollTop: chatCache.get(id)?.scrollTop ?? null, claude });
    if (chatCache.size > 20) chatCache.delete(chatCache.keys().next().value!);
  }, [items, page, claude]);
  useEffect(
    () => () => {
      const c = chatCache.get(id);
      if (c) c.scrollTop = stick.current ? null : lastTop.current;
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
  const restartClaude = () => restartAgent(session, state.status).catch((e) => setError(e.message));
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
      {isClaude && <ClaudeBar st={claude} update={update} onOpen={() => setPanel(true)} onRestart={session.access === 'control' ? restartClaude : undefined} />}
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
          {blocks.map((b) => (b.kind === 'tools' ? <ToolGroup key={b.items[0].id} items={b.items} onExpand={expand} /> : <Message key={b.it.id} it={b.it} onExpand={expand} onRewind={canRewind ? rewind : undefined} />))}
          {pending.map((p) => (
            <div key={p.key} class="msg user pending">
              <div class="bubble">
                {p.text}
                <span class="pending-tag">{p.sent ? '已发送' : '发送中…'}</span>
              </div>
            </div>
          ))}
          {live && (
            <div class={`live ${state.status}`}>
              <div class="live-head">
                <span class={`dot ${state.status}`} />
                {state.status === 'waiting' ? '等待你确认（可用下方快捷键，或切到终端）' : '实时画面'}
              </div>
              <pre>{state.preview}</pre>
            </div>
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
          slash={isClaude}
          agent={session.agent}
          onInteractive={onOpenTerminal}
          onPending={(text) => {
            // a shell has no chat log to confirm the message: don't show a placeholder
            if (session.agent === 'bash') return () => {};
            const key = Date.now() + Math.random();
            stick.current = true;
            setPending((ps) => [...ps, { key, text, sent: false }]);
            // drop it eventually even if it never shows up in the log (e.g. it was a /command)
            const expire = setTimeout(() => setPending((ps) => ps.filter((p) => p.key !== key)), 120000);
            return (ok: boolean) => {
              if (ok) setPending((ps) => ps.map((p) => (p.key === key ? { ...p, sent: true } : p)));
              else {
                clearTimeout(expire);
                setPending((ps) => ps.filter((p) => p.key !== key));
              }
            };
          }}
        />
      ) : (
        <div class="readonly">只读：你没有这个会话的操作权限</div>
      )}
    </div>
  );
}

function Composer(props: {
  sessionId: number;
  status: Status;
  /** offer Claude Code slash commands */
  slash?: boolean;
  agent?: SessionInfo['agent'];
  onInteractive?: () => void;
  onPending: (text: string) => (ok: boolean) => void;
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
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [text]);

  const update = (v: string) => {
    setText(v);
    store.set(draftKey, v || null);
  };

  // attachments: uploaded to the host first, their paths go into the message for the agent to read
  const [files, setFiles] = useState<{ key: number; name: string; path?: string; error?: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = Date.now() + Math.random();
      const name = file.name || `paste-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
      setFiles((fs) => [...fs, { key, name }]);
      fetch(`/_tw/api/sessions/${sessionId}/upload`, { method: 'POST', body: file, headers: { 'X-File-Name': encodeURIComponent(name) }, credentials: 'same-origin' })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, path: d.path } : f)));
        })
        .catch((e) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: e.message } : f))));
    }
  };
  const uploading = files.some((f) => !f.path && !f.error);
  const ready = files.filter((f) => f.path);
  // screenshots pasted into the box become attachments
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return;
    e.preventDefault();
    upload(pasted);
  };

  // optimistic: clear the box and show the message at once, the request runs behind it
  const send = async () => {
    const paths = ready.map((f) => f.path!);
    const msg = paths.length ? `${text.trim() || '请看这些文件：'}\n\n${paths.join('\n')}` : text;
    if (!msg.trim() || sending || uploading) return;
    setSending(true);
    setErr('');
    update('');
    setFiles([]);
    // slash commands don't show up as chat messages: no placeholder bubble for them
    const isCommand = /^\s*\//.test(msg);
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
  const running = status === 'busy' || status === 'waiting';
  const stop = () => key(props.agent === 'bash' ? ['C-c'] : ['Escape']);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && running && !e.isComposing) {
      e.preventDefault();
      stop();
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
            <span key={f.key} class={`att ${f.error ? 'err' : f.path ? 'ok' : 'busy'}`} title={f.error || f.path || '上传中…'}>
              {f.path ? '📎' : f.error ? '⚠' : <span class="spinner small-spin" />}
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
            <button class="icon-btn attach" aria-label="添加图片或文件" title="添加图片或文件（也可以直接粘贴截图）" onMouseDown={(e) => e.preventDefault()} onClick={() => fileInput.current?.click()}>
              <Icon.clip />
            </button>
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
          placeholder={coarse ? '输入消息' : '输入消息，Enter 发送，Shift+Enter 换行'}
          onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        {running && (
          <button class={`stop ${coarse ? 'round' : ''}`} aria-label="停止" title="停止当前输出（Esc）" onMouseDown={(e) => e.preventDefault()} onClick={stop}>
            <span class="stop-square" />
            {!coarse && '停止'}
          </button>
        )}
        <button class={`primary send ${coarse ? 'round' : ''}`} aria-label="发送" onMouseDown={(e) => e.preventDefault()} onClick={send} disabled={sending || uploading || (!text.trim() && !ready.length)}>
          {sending ? '…' : coarse ? <Icon.send /> : '发送'}
        </button>
      </div>
    </div>
  );
}

// ---------------- terminal tab ----------------

// keys a phone keyboard doesn't have, grouped like a terminal app's accessory bar
const TERM_KEYS: ([string, string] | '|')[] = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  '|',
  ['←', '\x1b[D'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['→', '\x1b[C'],
  '|',
  ['^C', '\x03'],
  ['⏎', '\r'],
  ['⇧Tab', '\x1b[Z'],
  '|',
  ['/', '/'],
  ['-', '-'],
  ['|', '|'],
  ['~', '~'],
  [':', ':'],
  ['*', '*'],
];

function TerminalView({ sessionId, canWrite }: { sessionId: number; canWrite: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const handle = useRef<import('./terminal').TermHandle | null>(null);
  const [state, setState] = useState('加载终端…');
  const [mods, setMods] = useState({ ctrl: false, alt: false });
  const [kb, setKb] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import('./terminal')
      .then(({ mountTerminal }) => {
        if (cancelled || !el.current) return;
        handle.current = mountTerminal(el.current, sessionId, setState, () => setMods({ ctrl: false, alt: false }));
        // on phones, focusing would pop the keyboard over the screen right away
        if (!coarsePointer) handle.current.focus();
      })
      // the page is older than the server's current build and its chunk is gone
      .catch(() => !cancelled && setState('stale'));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
    };
  }, [sessionId]);
  const toggleMod = (k: 'ctrl' | 'alt') => {
    const next = { ...mods, [k]: !mods[k] };
    setMods(next);
    handle.current?.setModifiers(next);
  };
  const paste = async () => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // clipboard API needs https; fall back to the system paste menu in a prompt
      text = prompt('粘贴要发送到终端的内容');
    }
    if (text) handle.current?.send(text);
  };
  // keep focus where it is: tapping a key must not close (or open) the phone keyboard
  const noBlur = (e: Event) => e.preventDefault();
  return (
    <div class="term-col">
      <div class="term-wrap">
        {state === 'stale' ? (
          <div class="term-state">
            网页已更新，
            <button class="link" onClick={() => location.reload()}>
              点此刷新
            </button>
          </div>
        ) : (
          state && <div class="term-state">{state}</div>
        )}
        <div class="term" ref={el} />
      </div>
      {coarsePointer && canWrite && (
        <div class="acc-bar">
          <button class={`acc kb ${kb ? 'on' : ''}`} aria-label="键盘" onMouseDown={noBlur} onClick={() => setKb(!!handle.current?.toggleKeyboard())}>
            <Icon.keys />
          </button>
          <div class="acc-scroll">
            <button class={`acc ${mods.ctrl ? 'on' : ''}`} onMouseDown={noBlur} onClick={() => toggleMod('ctrl')}>
              Ctrl
            </button>
            <button class={`acc ${mods.alt ? 'on' : ''}`} onMouseDown={noBlur} onClick={() => toggleMod('alt')}>
              Alt
            </button>
            {TERM_KEYS.map((k, i) =>
              k === '|' ? (
                <span key={i} class="acc-sep" />
              ) : (
                <button key={k[0]} class="acc" onMouseDown={noBlur} onClick={() => handle.current?.send(k[1])}>
                  {k[0]}
                </button>
              ),
            )}
            <span class="acc-sep" />
            <button class="acc" onMouseDown={noBlur} onClick={paste}>
              粘贴
            </button>
            <button class="acc" onMouseDown={noBlur} onClick={() => handle.current?.zoom(-1)}>
              A−
            </button>
            <button class="acc" onMouseDown={noBlur} onClick={() => handle.current?.zoom(1)}>
              A+
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- modals ----------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: any }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal card">
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useGroups(me: Me) {
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    api<Group[]>('GET', '/_tw/api/groups').then(setGroups, () => {});
  }, []);
  return me.role === 'admin' ? groups : groups.filter((g) => me.groups.includes(g.id));
}

function ShareFields({ groups, groupId, share }: { groups: Group[]; groupId?: number | null; share?: string }) {
  if (!groups.length) return null;
  return (
    <div class="row2">
      <label>
        共享给分组
        <select name="groupId" defaultValue={groupId ? String(groupId) : ''}>
          <option value="">不共享</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        分组权限
        <select name="share" defaultValue={share || 'view'}>
          <option value="view">只读</option>
          <option value="control">可操作</option>
        </select>
      </label>
    </div>
  );
}

function useHosts() {
  const [hosts, setHosts] = useState<HostInfo[] | null>(null);
  const load = useCallback(() => api<HostInfo[]>('GET', '/_tw/api/hosts').then(setHosts, () => setHosts([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return [hosts, load] as const;
}

interface ExistingTmux {
  socket: string;
  name: string;
  cwd: string;
  command: string;
  agent: 'claude' | 'codex' | 'bash';
  claudeSession?: string;
  attached: boolean;
  adoptedAs?: number;
}

/** Existing tmux sessions on a host that can be shown in tmux-web as they are. */
function AdoptList({ hostId, onAdopted }: { hostId: number; onAdopted: (id: number) => void }) {
  const [list, setList] = useState<ExistingTmux[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    setList(null);
    api<ExistingTmux[]>('GET', `/_tw/api/hosts/${hostId}/tmux`).then(setList, (e) => {
      setList([]);
      setErr(e.message);
    });
  }, [hostId]);
  const adopt = async (t: ExistingTmux) => {
    setBusy(t.name);
    setErr('');
    try {
      const { id } = await api<{ id: number }>('POST', `/_tw/api/hosts/${hostId}/adopt`, { name: t.name, socket: t.socket });
      onAdopted(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div class="form">
      <p class="dim small">直接接管主机上已有的 tmux 会话：里面的程序不会重启，你在自己终端里照常 attach，网页上同时可见。在网页里删除只会停止接管，不会关闭它。</p>
      {list === null && <p class="dim small">读取中…</p>}
      {list?.length === 0 && !err && <p class="dim small">这台主机上没有 tmux 会话</p>}
      {err && <p class="error small">{err}</p>}
      <div class="table">
        {list?.map((t) => (
          <div class="user-row" key={t.name}>
            <div>
              <b>{t.name}</b> <span class="tag">{t.claudeSession ? 'Claude' : t.command}</span>
              {t.attached && <span class="tag">已在别处打开</span>}
              <div class="dim small">{t.cwd}</div>
            </div>
            <div class="row-actions">
              {t.adoptedAs ? (
                <button type="button" onClick={() => onAdopted(t.adoptedAs!)}>
                  已导入，打开
                </button>
              ) : (
                <button type="button" class="primary" disabled={!!busy} onClick={() => adopt(t)}>
                  {busy === t.name ? '导入中…' : '导入'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ClaudeHistory {
  id: string;
  cwd: string;
  title: string;
  lastPrompt: string;
  mtime: number;
  size: number;
  running?: { tmux?: string };
  openAs?: number;
}

function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** Pick an earlier Claude Code conversation on the host to continue (claude --resume). */
function ClaudeHistoryPicker({ hostId, selected, onSelect }: { hostId: number; selected: ClaudeHistory | null; onSelect: (h: ClaudeHistory | null) => void }) {
  const [list, setList] = useState<ClaudeHistory[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    setList(null);
    setErr('');
    api<ClaudeHistory[]>('GET', `/_tw/api/hosts/${hostId}/claude-history`).then(setList, (e) => {
      setList([]);
      setErr(e.message);
    });
  }, [hostId]);
  const f = filter.trim().toLowerCase();
  const shown = (list || []).filter((h) => !f || `${h.title} ${h.lastPrompt} ${h.cwd}`.toLowerCase().includes(f));
  return (
    <div class="hist">
      <div class="hist-head">
        <span>从历史会话继续</span>
        {list && list.length > 5 && <input value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} placeholder="搜索标题、内容、目录" />}
      </div>
      <div class="hist-list">
        <button type="button" class={`hist-item ${selected ? '' : 'on'}`} onClick={() => onSelect(null)}>
          <span class="hist-title">新会话</span>
          <span class="hist-sub">不基于历史，在下面的目录里开始</span>
        </button>
        {list === null && <p class="dim small pad">读取历史会话…</p>}
        {err && <p class="error small pad">{err}</p>}
        {shown.map((h) => (
          <button type="button" key={h.id} class={`hist-item ${selected?.id === h.id ? 'on' : ''}`} onClick={() => onSelect(h)}>
            <span class="hist-title">
              {h.title || h.lastPrompt || h.id.slice(0, 8)}
              {h.running && <span class="tag warn">运行中{h.running.tmux ? ` · ${h.running.tmux}` : ''}</span>}
              {h.openAs && <span class="tag">已在 tmux-web</span>}
            </span>
            {h.title && h.lastPrompt && <span class="hist-sub">最近：{h.lastPrompt}</span>}
            <span class="hist-sub mono">
              {shortPath(h.cwd)} · {relTime(h.mtime)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewSession({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: (id: number) => void }) {
  const [mode, setMode] = useState<'new' | 'adopt'>('new');
  const [agent, setAgent] = useState<keyof typeof AGENT_LABEL>('claude');
  const [resume, setResume] = useState<ClaudeHistory | null>(null);
  const [hosts] = useHosts();
  const [hostId, setHostId] = useState<number | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = useGroups(me);
  useEffect(() => {
    if (hosts?.length && hostId === null) setHostId((hosts.find((h) => h.ok) ?? hosts[0]).id);
  }, [hosts]);
  useEffect(() => {
    if (hostId === null) return;
    setDirs([]);
    api<string[]>('GET', `/_tw/api/hosts/${hostId}/dirs`).then(setDirs, () => {});
  }, [hostId]);
  const host = hosts?.find((h) => h.id === hostId);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    setBusy(true);
    setErr('');
    try {
      const fromHistory = agent === 'claude' && resume;
      const { id } = await api<{ id: number }>('POST', '/_tw/api/sessions', {
        ...f,
        ...(fromHistory ? { resumeId: resume.id, cwd: resume.cwd, fork: !!resume.running, name: f.name || resume.title || '' } : {}),
        hostId,
        groupId: f.groupId ? Number(f.groupId) : null,
        share: f.groupId ? f.share : 'none',
      });
      onCreated(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="新建会话" onClose={onClose}>
      <div class="tabs mode-tabs">
        <button class={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          新建
        </button>
        <button class={mode === 'adopt' ? 'on' : ''} onClick={() => setMode('adopt')}>
          导入已有 tmux
        </button>
      </div>
      {mode === 'adopt' && hosts && hosts.length > 1 && (
        <label class="form">
          主机
          <select value={String(hostId ?? '')} onChange={(e) => setHostId(Number((e.target as HTMLSelectElement).value))}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === 'adopt' && hostId !== null && <AdoptList hostId={hostId} onAdopted={onCreated} />}
      <form onSubmit={submit} class="form" style={mode === 'adopt' ? 'display:none' : ''}>
        <label>
          类型
          <select name="agent" value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value as keyof typeof AGENT_LABEL)}>
            {(Object.keys(AGENT_LABEL) as (keyof typeof AGENT_LABEL)[]).map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        {hosts && hosts.length > 1 && (
          <label>
            主机
            <select value={String(hostId ?? '')} onChange={(e) => setHostId(Number((e.target as HTMLSelectElement).value))}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.ok === false ? '（离线）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {host && host.ok === false && <p class="error small">这台主机当前连不上：{host.error}</p>}
        {agent === 'claude' && hostId !== null && <ClaudeHistoryPicker key={hostId} hostId={hostId} selected={resume} onSelect={setResume} />}
        {agent === 'claude' && resume?.running && (
          <p class="small hint">
            这个会话正在{resume.running.tmux ? ` tmux「${resume.running.tmux}」` : '别处'}运行。两个进程同时写同一个对话会互相干扰，所以会<b>复制一份</b>再继续（--fork-session），原会话不受影响。
            {resume.openAs ? (
              <>
                {' '}
                也可以
                <button type="button" class="link" onClick={() => onCreated(resume.openAs!)}>
                  直接打开 tmux-web 里的那个会话
                </button>
                。
              </>
            ) : (
              ' 想直接操作原会话的话，用「导入已有 tmux」。'
            )}
          </p>
        )}
        <label style={agent === 'claude' && resume ? 'display:none' : ''}>
          工作目录
          <input name="cwd" list="dirs" key={hostId ?? 0} defaultValue={dirs[0] || ''} placeholder="~/项目，不存在会自动创建" required={!(agent === 'claude' && resume)} />
          <datalist id="dirs">
            {dirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label>
          名称
          <input name="name" placeholder={agent === 'claude' && resume?.title ? resume.title : '留空则用 agent + 目录名'} maxLength={60} />
        </label>
        <label>
          额外启动参数
          <input name="args" placeholder="例如 --model sonnet" autocapitalize="off" spellcheck={false} />
        </label>
        <ShareFields groups={groups} />
        {err && <p class="error">{err}</p>}
        <button class="primary" disabled={busy || hostId === null}>
          {busy ? '创建中…' : agent === 'claude' && resume ? (resume.running ? '复制一份并继续' : '继续这个会话') : '创建'}
        </button>
      </form>
    </Modal>
  );
}

function SessionSettings({ me, session, folders, onClose }: { me: Me; session: SessionInfo; folders: Folder[]; onClose: () => void }) {
  const [err, setErr] = useState('');
  const groups = useGroups(me);
  const owner = me.role === 'admin' || session.owner === me.username;
  const save = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    try {
      const patch: Record<string, unknown> = {};
      if (session.access === 'control') patch.note = f.note ?? '';
      if (owner) Object.assign(patch, { name: f.name, groupId: f.groupId ? Number(f.groupId) : null, share: f.groupId ? f.share : 'none' });
      if (Object.keys(patch).length) await api('PATCH', `/_tw/api/sessions/${session.id}`, patch);
      const folderId = f.folderId ? Number(f.folderId) : null;
      if (folderId !== session.folderId) await api('PUT', `/_tw/api/sessions/${session.id}/folder`, { folderId });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const restartClaude = async () => {
    try {
      if (await restartAgent(session, session.status)) onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const restart = async () => {
    if (!confirm(session.adopted ? `重启会关闭你原来的 tmux 会话「${session.tmux}」，然后在 tmux-web 里恢复对话。继续？` : '重启会话？正在运行的任务会被中断，对话会自动恢复。')) return;
    try {
      await api('POST', `/_tw/api/sessions/${session.id}/restart`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = async () => {
    if (!confirm(session.adopted ? `停止接管「${session.name}」？你原来的 tmux 会话不受影响。` : `删除会话「${session.name}」？tmux 里的进程会被结束（agent 的对话记录文件会保留）。`)) return;
    try {
      await api('DELETE', `/_tw/api/sessions/${session.id}`);
      location.hash = '';
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="会话设置" onClose={onClose}>
      <form onSubmit={save} class="form">
        <p class="dim small">
          {AGENT_LABEL[session.agent]} · {session.host}:{session.cwd} · 创建者 {session.owner}
        </p>
        {session.adopted && <p class="small">接管自你的 tmux 会话 <code>{session.tmux}</code>。删除只是停止接管；「重启」会关掉原会话，并在 tmux-web 里恢复对话。</p>}
        {owner && (
          <label>
            名称
            <input name="name" defaultValue={session.name} maxLength={60} />
          </label>
        )}
        {session.access === 'control' && (
          <label>
            备注
            <textarea name="note" rows={2} maxLength={500} defaultValue={session.note} placeholder="显示在会话名下面，比如在做什么、注意事项" />
          </label>
        )}
        <label>
          文件夹
          <select name="folderId" defaultValue={session.folderId ? String(session.folderId) : ''}>
            <option value="">未分组</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {!folders.length && <small>还没有文件夹，可以在会话列表上方新建</small>}
        </label>
        {owner && <ShareFields groups={groups} groupId={session.groupId} share={session.share === 'none' ? 'view' : session.share} />}
        <button class="primary">保存</button>
        {err && <p class="error">{err}</p>}
        <div class="row-actions">
          {session.access === 'control' && session.agent === 'claude' && (
            <button type="button" onClick={restartClaude} title="只重启 claude 进程，对话接着继续（更新版本后用）">
              重启 Claude
            </button>
          )}
          {session.access === 'control' && (
            <button type="button" onClick={restart} title="关闭整个 tmux 会话再重建">
              {session.adopted ? '迁移到 tmux-web' : '重建会话'}
            </button>
          )}
          {owner && (
            <button type="button" class="danger" onClick={remove}>
              {session.adopted ? '停止接管' : '删除'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

interface ApiToken {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** Tokens for apps (e.g. the phone app) and scripts: Authorization: Bearer ... */
function TokensModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ApiToken[]>([]);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<ApiToken[]>('GET', '/_tw/api/tokens').then(setList, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const create = async (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    try {
      setFresh(await api('POST', '/_tw/api/tokens', { name: new FormData(form).get('name') }));
      form.reset();
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const revoke = async (t: ApiToken) => {
    if (!confirm(`吊销「${t.name}」？用它登录的设备会立刻失效。`)) return;
    await api('DELETE', `/_tw/api/tokens/${t.id}`).catch((e) => setErr(e.message));
    load();
  };
  return (
    <Modal title="API 令牌" onClose={onClose}>
      <p class="dim small">给手机 App、脚本等用的长期凭证（请求头 Authorization: Bearer 令牌）。令牌只在创建时显示一次。</p>
      {fresh && (
        <div class="keybox">
          <div class="small">「{fresh.name}」的令牌，请现在复制保存：</div>
          <pre>{fresh.token}</pre>
          <button type="button" onClick={() => navigator.clipboard?.writeText(fresh.token).catch(() => {})}>
            复制
          </button>
        </div>
      )}
      <div class="table" style="margin-top:10px">
        {list.map((t) => (
          <div class="user-row" key={t.id}>
            <div>
              <b>{t.name}</b>
              <div class="dim small">
                创建于 {new Date(t.created_at).toLocaleString()} · {t.last_used_at ? `最近使用 ${relTime(t.last_used_at)}` : '还没用过'}
              </div>
            </div>
            <button class="danger" onClick={() => revoke(t)}>
              吊销
            </button>
          </div>
        ))}
        {!list.length && <p class="dim small">还没有令牌</p>}
      </div>
      {err && <p class="error">{err}</p>}
      <form class="input-row" style="margin-top:12px" onSubmit={create}>
        <input name="name" placeholder="名字，比如「我的手机」" required maxLength={40} />
        <button class="primary">创建</button>
      </form>
    </Modal>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [msg, setMsg] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    try {
      await api('POST', '/_tw/api/me/password', { oldPassword: f.get('old'), newPassword: f.get('new') });
      setMsg('已修改');
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <Modal title="修改密码" onClose={onClose}>
      <form onSubmit={submit} class="form">
        <label>
          原密码
          <input name="old" type="password" autocomplete="current-password" required />
        </label>
        <label>
          新密码
          <input name="new" type="password" autocomplete="new-password" minLength={6} required />
        </label>
        {msg && <p class="small">{msg}</p>}
        <button class="primary">确定</button>
      </form>
    </Modal>
  );
}

function AdminModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [hosts, loadHosts] = useHosts();
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const load = () => {
    api<Me[]>('GET', '/_tw/api/users').then(setUsers, (e) => setErr(e.message));
    api<Group[]>('GET', '/_tw/api/groups').then(setGroups, () => {});
    loadHosts();
  };
  useEffect(() => {
    api<{ publicKey: string }>('GET', '/_tw/api/ssh-key').then((r) => setKey(r.publicKey || ''), () => {});
  }, []);
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const create = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = new FormData(form);
    run(async () => {
      await api('POST', '/_tw/api/users', {
        username: f.get('username'),
        password: f.get('password'),
        role: f.get('role'),
        groups: f.getAll('groups').map(Number),
      });
      form.reset();
    });
  };
  const addHost = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    run(async () => {
      const h = await api<HostInfo>('POST', '/_tw/api/hosts', { ...f, port: Number(f.port || 22), ownerId: f.ownerId ? Number(f.ownerId) : null });
      if (h.ok === false) setErr(`已添加，但暂时连不上：${h.error}`);
      form.reset();
    });
  };
  const copyKey = () => navigator.clipboard?.writeText(`echo '${key}' >> ~/.ssh/authorized_keys`).catch(() => {});
  const toggleGroup = (u: Me, gid: number) =>
    run(() => api('PATCH', `/_tw/api/users/${u.id}`, { groups: u.groups.includes(gid) ? u.groups.filter((g) => g !== gid) : [...u.groups, gid] }));
  const resetPassword = (u: Me) => {
    const p = prompt(`为 ${u.username} 设置新密码（至少 6 位）`);
    if (p) run(() => api('PATCH', `/_tw/api/users/${u.id}`, { password: p }));
  };
  const addGroup = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = new FormData(form).get('name');
    run(async () => {
      await api('POST', '/_tw/api/groups', { name });
      form.reset();
    });
  };

  return (
    <Modal title="主机、账号与分组" onClose={onClose}>
      {err && <p class="error">{err}</p>}
      <h3>主机</h3>
      <div class="table">
        {(hosts || []).map((h) => (
          <div class="user-row" key={h.id}>
            <div>
              <span class={`dot ${h.ok ? 'idle' : 'waiting'}`} /> <b>{h.name}</b>{' '}
              <span class="dim small">{h.kind === 'local' ? '本进程直接运行' : `${h.user}@${h.address}:${h.port}`}</span>
              {h.ownerId !== null && <span class="tag">仅 {users.find((u) => u.id === h.ownerId)?.username ?? '?'}</span>}
              <div class={`small ${h.ok ? 'dim' : 'error'}`}>{h.ok ? `${h.tmux} · ${h.home}` : h.error || '未检测'}</div>
            </div>
            <div class="row-actions">
              <button onClick={() => run(() => api('POST', `/_tw/api/hosts/${h.id}/check`))}>检测</button>
              <button class="danger" onClick={() => confirm(`删除主机 ${h.name}？`) && run(() => api('DELETE', `/_tw/api/hosts/${h.id}`))}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      {key && (
        <div class="keybox">
          <div class="small dim">在每台主机上，把这把公钥加进对应 SSH 用户的 authorized_keys：</div>
          <pre>echo '{key}' &gt;&gt; ~/.ssh/authorized_keys</pre>
          <button type="button" onClick={copyKey}>
            复制命令
          </button>
        </div>
      )}
      <form onSubmit={addHost} class="form boxed">
        <h3>添加主机</h3>
        <div class="row2">
          <label>
            名称
            <input name="name" required maxLength={40} placeholder="例如 gpu-server" />
          </label>
          <label>
            可用账号
            <select name="ownerId">
              <option value="">所有人</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  仅 {u.username}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="row3">
          <label>
            地址
            <input name="address" required placeholder="192.168.1.10" autocapitalize="off" spellcheck={false} />
          </label>
          <label>
            端口
            <input name="port" type="number" defaultValue="22" min={1} max={65535} />
          </label>
          <label>
            SSH 用户
            <input name="user" required autocapitalize="off" spellcheck={false} />
          </label>
        </div>
        <button class="primary">添加并检测</button>
      </form>
      <h3>账号</h3>
      <div class="table">
        {users.map((u) => (
          <div class="user-row" key={u.id}>
            <div>
              <b>{u.username}</b> {u.role === 'admin' && <span class="tag">管理员</span>}
              {u.disabled && <span class="tag warn">已停用</span>}
              {groups.length > 0 && (
                <div class="chips">
                  {groups.map((g) => (
                    <button key={g.id} class={`chip ${u.groups.includes(g.id) ? 'on' : ''}`} onClick={() => toggleGroup(u, g.id)}>
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div class="row-actions">
              <button onClick={() => resetPassword(u)}>改密码</button>
              {u.id !== me.id && (
                <>
                  <button onClick={() => run(() => api('PATCH', `/_tw/api/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? '启用' : '停用'}</button>
                  <button
                    class="danger"
                    onClick={() => confirm(`删除账号 ${u.username}？它创建的会话、只给它用的主机也会被删除（主机上的文件不受影响）。`) && run(() => api('DELETE', `/_tw/api/users/${u.id}`))}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={create} class="form boxed">
        <h3>新建账号</h3>
        <div class="row2">
          <label>
            用户名
            <input name="username" required pattern="[a-z][a-z0-9_\-]{1,30}" autocapitalize="off" title="小写字母开头，2-31 位" />
          </label>
          <label>
            密码
            <input name="password" type="password" minLength={6} required autocomplete="new-password" />
          </label>
        </div>
        <label>
          角色
          <select name="role">
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        {groups.length > 0 && (
          <div class="chips">
            {groups.map((g) => (
              <label key={g.id} class="chip-check">
                <input type="checkbox" name="groups" value={g.id} /> {g.name}
              </label>
            ))}
          </div>
        )}
        <button class="primary">创建账号</button>
      </form>
      <h3>分组</h3>
      <div class="chips">
        {groups.map((g) => (
          <span key={g.id} class="chip on">
            {g.name}
            <button class="ghost x" onClick={() => confirm(`删除分组 ${g.name}？`) && run(() => api('DELETE', `/_tw/api/groups/${g.id}`))}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={addGroup} class="input-row">
        <input name="name" placeholder="新分组名" required maxLength={40} />
        <button>添加</button>
      </form>
    </Modal>
  );
}

// ---------------- shell ----------------

// ---------------- activity: order, unread ----------------

/** Waiting for you first, then running, then most recently active. */
function sortSessions(list: SessionInfo[]): SessionInfo[] {
  const rank = (s: SessionInfo) => (s.status === 'waiting' ? 0 : s.status === 'busy' ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt);
}

/**
 * What you have seen, per session (activity time when you last looked), kept in this browser.
 * A session is unread when it did something after that.
 */
function useUnread(sessions: SessionInfo[] | null, current: number | null): Set<number> {
  const [seen, setSeen] = useState<Record<number, number>>(() => {
    try {
      return JSON.parse(store.get('tw:seen') || '{}');
    } catch {
      return {};
    }
  });
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const save = (next: Record<number, number>) => {
    store.set('tw:seen', JSON.stringify(next));
    return next;
  };
  // sessions seen for the first time count as read (no flood of dots on first use)
  useEffect(() => {
    if (!sessions) return;
    setSeen((cur) => {
      const missing = sessions.filter((s) => !(s.id in cur));
      if (!missing.length) return cur;
      const next = { ...cur };
      for (const s of missing) next[s.id] = s.activityAt;
      return save(next);
    });
  }, [sessions]);
  // the open session is being read, as long as the page is in front
  const open = sessions?.find((s) => s.id === current);
  useEffect(() => {
    if (!open || !visible) return;
    setSeen((cur) => (cur[open.id] >= open.activityAt ? cur : save({ ...cur, [open.id]: open.activityAt })));
  }, [open?.id, open?.activityAt, visible]);
  return new Set((sessions || []).filter((s) => s.activityAt > (seen[s.id] ?? Infinity) + 1000 && !(s.id === current && visible)).map((s) => s.id));
}

/** Short relative time for lists. */
function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}天前`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

// ---------------- in-page alerts ----------------

const alertsEnabled = () => store.get('tw:alerts') !== 'off';

const NOTICE_ICON: Record<Notice['kind'], string> = { waiting: '⚠', done: '✓', offline: '⚡', ended: '■' };

function Toasts({ list, onOpen, onClose }: { list: { key: number; n: Notice }[]; onOpen: (n: Notice) => void; onClose: (key: number) => void }) {
  if (!list.length) return null;
  return (
    <div class="toasts">
      {list.map(({ key, n }) => (
        <div key={key} class={`toast ${n.kind}`} onClick={() => onOpen(n)} role="button">
          <span class="toast-icon">{NOTICE_ICON[n.kind]}</span>
          <span class="toast-main">
            <b>
              {n.session} · {n.title}
            </b>
            {n.text && <span class="toast-text">{n.text}</span>}
          </span>
          <button
            class="toast-x"
            aria-label="关闭"
            onClick={(e) => {
              e.stopPropagation();
              onClose(key);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------- folders ----------------

interface SessionGroup {
  folder: Folder | null;
  sessions: SessionInfo[];
}

/** Sessions by folder (folders in their order, unfiled last). Without folders: one plain group. */
function groupByFolder(sessions: SessionInfo[], folders: Folder[]): SessionGroup[] {
  if (!folders.length) return [{ folder: null, sessions }];
  const ids = new Set(folders.map((f) => f.id));
  const groups: SessionGroup[] = folders.map((f) => ({ folder: f, sessions: sessions.filter((s) => s.folderId === f.id) }));
  groups.push({ folder: null, sessions: sessions.filter((s) => s.folderId === null || !ids.has(s.folderId)) });
  return groups;
}

/** Which folders are collapsed; remembered in this browser. "u" = the unfiled group. */
function useCollapsed(): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(store.get('tw:collapsed') || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setSet((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      store.set('tw:collapsed', JSON.stringify([...next]));
      return next;
    });
  return [set, toggle];
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg class={`chev ${open ? 'open' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** Create / rename / annotate / delete a folder. */
function FolderModal({ folder, onClose }: { folder: Folder | null; onClose: () => void }) {
  const [err, setErr] = useState('');
  const save = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    try {
      if (folder) await api('PATCH', `/_tw/api/folders/${folder.id}`, f);
      else await api('POST', '/_tw/api/folders', f);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = async () => {
    if (!folder || !confirm(`删除文件夹「${folder.name}」？里面的会话会移到「未分组」，不会被删除。`)) return;
    try {
      await api('DELETE', `/_tw/api/folders/${folder.id}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={folder ? '编辑文件夹' : '新建文件夹'} onClose={onClose}>
      <form class="form" onSubmit={save}>
        <label>
          名称
          <input name="name" defaultValue={folder?.name ?? ''} required maxLength={40} autoFocus={!coarsePointer} />
        </label>
        <label>
          备注
          <textarea name="note" rows={3} maxLength={500} defaultValue={folder?.note ?? ''} placeholder="比如这组会话是做什么的" />
        </label>
        {err && <p class="error">{err}</p>}
        <button class="primary">{folder ? '保存' : '创建'}</button>
        {folder && (
          <div class="row-actions">
            <button type="button" class="danger" onClick={remove}>
              删除文件夹
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** A collapsible folder header: arrow, name, count, note; drop target for dragged sessions. */
function FolderHeader(props: { group: SessionGroup; open: boolean; onToggle: () => void; onEdit?: () => void; onDropSession?: (id: number) => void; big?: boolean }) {
  const { folder, sessions } = props.group;
  const [over, setOver] = useState(false);
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  return (
    <div
      class={`folder-head ${props.big ? 'big' : ''} ${over ? 'drop' : ''}`}
      onDragOver={(e) => {
        if (!props.onDropSession) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = Number(e.dataTransfer?.getData('text/tw-session'));
        if (id && props.onDropSession) props.onDropSession(id);
      }}
    >
      <button class="folder-toggle" onClick={props.onToggle} aria-expanded={props.open}>
        <Chevron open={props.open} />
        <span class="folder-name">{folder ? folder.name : '未分组'}</span>
        <span class="folder-count">{sessions.length}</span>
        {!props.open && waiting > 0 && <span class="dot waiting" title={`${waiting} 个等待确认`} />}
      </button>
      {folder && props.onEdit && (
        <button class="icon-btn folder-edit" onClick={props.onEdit} aria-label="编辑文件夹">
          <Icon.more />
        </button>
      )}
      {folder?.note && props.open && <div class="folder-note">{folder.note}</div>}
    </div>
  );
}

const moveToFolder = (sessionId: number, folderId: number | null) => api('PUT', `/_tw/api/sessions/${sessionId}/folder`, { folderId }).catch((e) => alert(e.message));

function Sidebar(props: {
  me: Me;
  hostBanner: boolean;
  sessions: SessionInfo[];
  folders: Folder[];
  current: number | null;
  onPick: (id: number) => void;
  onNew: () => void;
  onAdmin: () => void;
  onPassword: () => void;
  onLogout: () => void;
  onEditFolder: (f: Folder | null) => void;
  onTokens: () => void;
  unread: Set<number>;
  alerts: boolean;
  onToggleAlerts: () => void;
}) {
  const { me, sessions, current } = props;
  const multiHost = new Set(sessions.map((s) => s.hostId)).size > 1;
  const [collapsed, toggle] = useCollapsed();
  const groups = groupByFolder(sortSessions(sessions), props.folders);
  const item = (s: SessionInfo) => (
    <button
      key={s.id}
      class={`session-item ${s.id === current ? 'active' : ''}`}
      onClick={() => props.onPick(s.id)}
      draggable={!coarsePointer && props.folders.length > 0}
      onDragStart={(e) => e.dataTransfer?.setData('text/tw-session', String(s.id))}
      title={s.note || undefined}
    >
      <span class={`dot ${s.status}`} title={STATUS_LABEL[s.status]} />
      <span class="s-main">
        <span class="s-name">
          {s.name}
          {props.unread.has(s.id) && <span class="unread" title="有新动态" />}
        </span>
        <span class="s-sub">
          {s.note ||
            `${AGENT_LABEL[s.agent]}${multiHost ? ` · ${s.host}` : ''}${s.owner !== me.username ? ` · ${s.owner}` : ''}${s.access === 'view' ? ' · 只读' : ''}`}
        </span>
      </span>
      <span class="s-time">{ago(s.activityAt)}</span>
    </button>
  );
  return (
    <aside class="sidebar">
      <div class="side-head">
        <span class="brand">tmux-web</span>
        <button class="icon-btn" onClick={() => props.onEditFolder(null)} aria-label="新建文件夹" title="新建文件夹">
          <Icon.folderPlus />
        </button>
        <button class="primary small-btn" onClick={props.onNew}>
          ＋ 新建
        </button>
      </div>
      {props.hostBanner && (
        <button class="host-banner" onClick={props.onAdmin}>
          有主机连不上，点此查看
        </button>
      )}
      <nav class="session-list">
        {groups.map((g) => {
          const key = g.folder ? String(g.folder.id) : 'u';
          const open = !collapsed.has(key);
          if (!g.folder && groups.length === 1) return g.sessions.map(item);
          if (!g.folder && !g.sessions.length) return null;
          return (
            <div class="folder" key={key}>
              <FolderHeader
                group={g}
                open={open}
                onToggle={() => toggle(key)}
                onEdit={g.folder ? () => props.onEditFolder(g.folder) : undefined}
                onDropSession={(id) => moveToFolder(id, g.folder?.id ?? null)}
              />
              {open && <div class="folder-body">{g.sessions.length ? g.sessions.map(item) : <p class="dim small folder-empty">空文件夹。拖动会话到这里，或在会话设置里选择文件夹。</p>}</div>}
            </div>
          );
        })}
        {!sessions.length && <p class="dim small pad">还没有会话，点「新建」开始。</p>}
      </nav>
      <div class="side-foot">
        <span class="dim small">{me.username}</span>
        <span class="spacer" />
        <button class="ghost small" onClick={props.onToggleAlerts} title={props.alerts ? '页内提醒：开（点击关闭）' : '页内提醒：关（点击开启）'}>
          {props.alerts ? '🔔' : '🔕'}
        </button>
        <ThemeCycle />
        {me.role === 'admin' && (
          <button class="ghost small" onClick={props.onAdmin}>
            账号
          </button>
        )}
        <button class="ghost small" onClick={props.onPassword}>
          密码
        </button>
        <button class="ghost small" onClick={props.onTokens} title="API 令牌（App / 脚本）">
          令牌
        </button>
        <button class="ghost small" onClick={props.onLogout}>
          退出
        </button>
      </div>
    </aside>
  );
}

/** "5173", "5173/docs", ":5173/x", "localhost:5173/x?a=1", "http://127.0.0.1:5173/" → port + path */
function parseTarget(input: string): { port: number; path: string } | null {
  const m = /^\s*(?:https?:\/\/)?(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])?:)?(\d{1,5})(\/[^\s]*)?\s*$/.exec(input);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? { port, path: m[2] || '/' } : null;
}

interface PortInfo {
  port: number;
  addr: string;
  proc?: string;
}

/** Shows a web app running on the session's host (served through tmux-web's /p/ proxy). */
function PreviewView({ session }: { session: SessionInfo }) {
  const key = `tw:pv:${session.id}`;
  const [input, setInput] = useState(() => store.get(key) || '');
  const [src, setSrc] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [allPorts, setAllPorts] = useState(false);
  const [err, setErr] = useState('');
  const loadPorts = useCallback(() => {
    api<PortInfo[]>('GET', `/_tw/api/hosts/${session.hostId}/ports`).then(setPorts, (e) => {
      setPorts([]);
      setErr(e.message);
    });
  }, [session.hostId]);
  const open = (value: string) => {
    const t = parseTarget(value);
    if (!t) return setErr('请输入端口，可以带路径，例如 5173 或 5173/docs');
    setErr('');
    setInput(value.trim());
    store.set(key, value.trim());
    setSrc(`/p/${session.hostId}/${t.port}${t.path}`);
    setNonce((n) => n + 1);
  };
  useEffect(() => {
    loadPorts();
    const saved = store.get(key);
    if (saved && parseTarget(saved)) open(saved);
  }, [session.id]);
  return (
    <div class="preview">
      <form
        class="pv-bar"
        onSubmit={(e) => {
          e.preventDefault();
          open(input);
        }}
      >
        <span class="pv-host dim">{session.host}:</span>
        <input value={input} onInput={(e) => setInput((e.target as HTMLInputElement).value)} placeholder="端口/路径，如 5173/docs" autocapitalize="off" spellcheck={false} inputMode="url" />
        <button class="primary">打开</button>
        {src && (
          <>
            <button type="button" title="刷新" onClick={() => setNonce((n) => n + 1)}>
              ↻
            </button>
            <a class="btn" href={src} target="_blank" rel="noopener" title="在新窗口打开">
              ↗
            </a>
          </>
        )}
      </form>
      {err && <div class="banner error">{err}</div>}
      {src ? (
        <iframe key={nonce} class="pv-frame" src={src} title="预览" />
      ) : (
        <div class="pv-empty">
          <p class="dim">输入 agent 启动的网页端口（可以带路径），会通过 tmux-web 转发显示在这里，不需要另外开放端口。</p>
          <div class="pv-ports">
            <span class="dim small">{session.host} 上正在监听的端口：</span>
            {ports === null && <span class="dim small">读取中…</span>}
            {ports?.length === 0 && <span class="dim small">没有</span>}
            {/* the process name is only visible for the SSH user's own processes: those are the agent's */}
            {ports?.filter((p) => allPorts || p.proc || !ports.some((x) => x.proc)).map((p) => (
              <button key={p.port} class="chip on" onClick={() => open(String(p.port))}>
                {p.port}
                {p.proc ? ` · ${p.proc}` : ''}
              </button>
            ))}
            {ports?.some((p) => !p.proc) && ports.some((p) => p.proc) && (
              <button class="link" onClick={() => setAllPorts((v) => !v)}>
                {allPorts ? '只看我的' : `全部 (${ports.length})`}
              </button>
            )}
            <button class="link" onClick={loadPorts}>
              刷新
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type Tab = 'chat' | 'term' | 'preview';

const VIEWS: [Tab, string, () => any][] = [
  ['chat', '对话', Icon.chat],
  ['term', '终端', Icon.term],
  ['preview', '预览', Icon.globe],
];

function SessionPane({ me, session, folders, narrow, onBack }: { me: Me; session: SessionInfo; folders: Folder[]; narrow: boolean; onBack: () => void }) {
  const tabKey = `tw:tab:${session.id}`;
  const initialTab = (): Tab => (store.get(tabKey) as Tab) || (session.agent === 'bash' ? 'term' : 'chat');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState(false);
  useEffect(() => setTab(initialTab()), [session.id]);
  const pick = (t: Tab) => {
    setTab(t);
    store.set(tabKey, t);
  };
  return (
    <section class="pane">
      <header class={`pane-head ${tab === 'term' && narrow ? 'dark' : ''}`}>
        {narrow && (
          <button class="icon-btn back" onClick={onBack} aria-label="返回">
            <Icon.back />
          </button>
        )}
        <div class="title">
          <span class="t-name">{session.name}</span>
          <span class="t-sub">
            <span class={`dot ${session.status}`} /> {STATUS_LABEL[session.status]}
            {narrow ? '' : ` · ${session.host}:${session.cwd}`}
          </span>
        </div>
        {narrow ? (
          <div class="view-switch">
            {VIEWS.map(([t, label, I]) => (
              <button key={t} class={`icon-btn ${tab === t ? 'on' : ''}`} aria-label={label} onClick={() => pick(t)}>
                <I />
              </button>
            ))}
          </div>
        ) : (
          <div class="tabs">
            {VIEWS.map(([t, label]) => (
              <button key={t} class={tab === t ? 'on' : ''} onClick={() => pick(t)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <button class="icon-btn" onClick={() => setSettings(true)} aria-label="设置">
          <Icon.more />
        </button>
      </header>
      {tab === 'chat' && <ChatView key={session.id} session={session} onOpenTerminal={() => pick('term')} />}
      {tab === 'term' && <TerminalView key={session.id} sessionId={session.id} canWrite={session.access === 'control'} />}
      {tab === 'preview' && <PreviewView key={session.id} session={session} />}
      {settings && <SessionSettings me={me} session={session} folders={folders} onClose={() => setSettings(false)} />}
    </section>
  );
}

/** Shorten a path for small screens: the last two segments. */
const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
};

/** Phone home screen: grouped session rows (iOS-style lists), search, a floating + button. */
function MobileHome(props: {
  me: Me;
  sessions: SessionInfo[] | null;
  folders: Folder[];
  hostBanner: boolean;
  onPick: (id: number) => void;
  onNew: () => void;
  onMenu: () => void;
  onAdmin: () => void;
  onEditFolder: (f: Folder | null) => void;
  unread: Set<number>;
}) {
  const { sessions } = props;
  const multiHost = new Set((sessions || []).map((s) => s.hostId)).size > 1;
  const [collapsed, toggle] = useCollapsed();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = (sessions || []).filter((s) => !q || `${s.name} ${s.note} ${s.cwd} ${s.host}`.toLowerCase().includes(q));
  const sorted = sortSessions(shown);
  const groups = groupByFolder(sorted, q ? [] : props.folders);
  const count = (st: Status) => (sessions || []).filter((s) => s.status === st).length;
  const summary = sessions
    ? [`${sessions.length} 个会话`, count('busy') && `${count('busy')} 个运行中`, count('waiting') && `${count('waiting')} 个等待确认`].filter(Boolean).join(' · ')
    : '';
  const row = (s: SessionInfo) => (
    <button key={s.id} class={`m-row ${s.status}`} onClick={() => props.onPick(s.id)}>
      <span class={`m-badge ${s.agent}`}>
        {AGENT_LABEL[s.agent].slice(0, 1)}
        <span class={`m-dot dot ${s.status}`} />
      </span>
      <span class="m-main">
        <span class="m-name">
          {s.name}
          {props.unread.has(s.id) && <span class="unread" />}
        </span>
        <span class="m-sub">
          {s.note || (
            <span class="mono">
              {multiHost ? `${s.host}:` : ''}
              {shortPath(s.cwd)}
            </span>
          )}
        </span>
      </span>
      {s.status !== 'idle' ? <span class={`m-pill ${s.status}`}>{STATUS_LABEL[s.status]}</span> : <span class="m-time">{ago(s.activityAt)}</span>}
      <span class="m-chev">
        <Chevron open={false} />
      </span>
    </button>
  );
  return (
    <section class="m-home">
      <header class="m-head">
        <div class="m-title">
          <h1>会话</h1>
          {summary && <span class="m-summary">{summary}</span>}
        </div>
        <button class="icon-btn" onClick={() => props.onEditFolder(null)} aria-label="新建文件夹">
          <Icon.folderPlus />
        </button>
        <button class="icon-btn" onClick={props.onMenu} aria-label="我的">
          <Icon.user />
        </button>
      </header>
      <div class="m-list">
        {sessions && sessions.length > 4 && (
          <label class="m-search">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="search" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="搜索名称、备注、路径" />
          </label>
        )}
        {props.hostBanner && (
          <button class="host-banner" onClick={props.onAdmin}>
            有主机连不上，点此查看
          </button>
        )}
        {sessions === null && <p class="dim pad">加载中…</p>}
        {sessions?.length === 0 && <p class="dim pad">还没有会话，点右下角 ＋ 新建，或导入已有的 tmux 会话。</p>}
        {q && !shown.length && <p class="dim pad">没有匹配的会话</p>}
        {groups.map((g) => {
          const key = g.folder ? String(g.folder.id) : 'u';
          const open = q ? true : !collapsed.has(key);
          const plain = !g.folder && groups.length === 1;
          if (!g.sessions.length && (plain || !g.folder)) return null;
          return (
            <div class="m-section" key={key}>
              {!plain && <FolderHeader big group={g} open={open} onToggle={() => toggle(key)} onEdit={g.folder ? () => props.onEditFolder(g.folder) : undefined} />}
              {open && (g.sessions.length ? <div class="m-group">{g.sessions.map(row)}</div> : <p class="dim small folder-empty">空文件夹。在会话设置里可以把会话放进来。</p>)}
            </div>
          );
        })}
      </div>
      <button class="fab" onClick={props.onNew} aria-label="新建会话">
        <Icon.plus />
      </button>
    </section>
  );
}

function MenuSheet({ me, onClose, onAdmin, onPassword, onTokens, onLogout }: { me: Me; onClose: () => void; onAdmin: () => void; onPassword: () => void; onTokens: () => void; onLogout: () => void }) {
  return (
    <Modal title={me.username} onClose={onClose}>
      <div class="sheet-theme">
        <span class="dim small">外观</span>
        <ThemeSwitch />
      </div>
      <label class="sheet-toggle">
        <span>
          页内提醒
          <small class="dim">会话等待确认或完成时弹出提示、手机震动</small>
        </span>
        <input type="checkbox" defaultChecked={alertsEnabled()} onChange={(e) => store.set('tw:alerts', (e.target as HTMLInputElement).checked ? null : 'off')} />
      </label>
      <div class="sheet-list">
        {me.role === 'admin' && <button onClick={onAdmin}>主机、账号与分组</button>}
        <button onClick={onPassword}>修改密码</button>
        <button onClick={onTokens}>API 令牌（App / 脚本）</button>
        <button class="danger" onClick={onLogout}>
          退出登录
        </button>
      </div>
    </Modal>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const narrow = useNarrow();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [current, setCurrent] = useHashSession();
  const [modal, setModal] = useState<'new' | 'admin' | 'password' | 'menu' | 'tokens' | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  // folder being edited; null = creating one; undefined = dialog closed
  const [editFolder, setEditFolder] = useState<Folder | null | undefined>(undefined);
  const [hostBanner, setHostBanner] = useState(false);
  const unread = useUnread(sessions, current);
  // relative times in the lists
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // in-page alerts from the server's notifications
  const [toasts, setToasts] = useState<{ key: number; n: Notice }[]>([]);
  const [alerts, setAlerts] = useState(alertsEnabled());
  const [missed, setMissed] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(
    () =>
      liveStream(() => '/_tw/api/notifications/stream', {
        notice: (n: Notice) => {
          if (!alertsEnabled()) return;
          // already looking at it
          if (!document.hidden && currentRef.current === n.sessionId) return;
          const key = n.id;
          setToasts((t) => [...t.filter((x) => x.n.sessionId !== n.sessionId).slice(-2), { key, n }]);
          setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), n.kind === 'waiting' ? 15000 : 8000);
          if (document.hidden) setMissed((m) => m + 1);
          if (n.kind === 'waiting' || n.kind === 'done') navigator.vibrate?.(n.kind === 'waiting' ? [120, 60, 120] : 80);
        },
      }),
    [],
  );
  useEffect(() => {
    const on = () => !document.hidden && setMissed(0);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const toggleAlerts = () => {
    store.set('tw:alerts', alerts ? 'off' : null);
    setAlerts(!alerts);
  };
  useEffect(() => {
    if (me.role !== 'admin' || modal) return;
    api<HostInfo[]>('GET', '/_tw/api/hosts').then((hs) => setHostBanner(hs.some((h) => h.ok === false)), () => {});
  }, [modal]);

  useEffect(
    () =>
      liveStream(
        () => '/_tw/api/events',
        {
          sessions: setSessions,
          folders: setFolders,
          status: ({ id, status }) => setSessions((cur) => cur && cur.map((s) => (s.id === id ? { ...s, status } : s))),
          activity: ({ id, at }) => setSessions((cur) => cur && cur.map((s) => (s.id === id ? { ...s, activityAt: Math.max(s.activityAt, at) } : s))),
        },
        // a 401 also ends up as an error: confirm the login is still valid
        (ok) => ok || api('GET', '/_tw/api/me').catch(() => {}),
      ),
    [],
  );

  const session = sessions?.find((s) => s.id === current) ?? null;
  // opened from the list: "back" is a real history step back (same as the system back gesture)
  const fromList = useRef(false);
  const pick = (id: number) => {
    fromList.current = current === null;
    setCurrent(id);
  };
  const back = () => {
    if (fromList.current) {
      fromList.current = false;
      history.back();
    } else setCurrent(null);
  };
  const logout = async () => {
    await api('POST', '/_tw/api/logout').catch(() => {});
    onLogout();
  };

  useEffect(() => {
    const base = session ? `${session.status === 'waiting' ? '⚠ ' : ''}${session.name} · tmux-web` : 'tmux-web';
    document.title = missed ? `(${missed}) ${base}` : base;
  }, [session?.name, session?.status, missed]);

  return (
    <div class="app">
      {narrow ? (
        <>
          {/* the list stays mounted under the session view: going back keeps its scroll and state */}
          <MobileHome
            me={me}
            sessions={sessions}
            folders={folders}
            hostBanner={hostBanner}
            onPick={pick}
            onNew={() => setModal('new')}
            onMenu={() => setModal('menu')}
            onAdmin={() => setModal('admin')}
            onEditFolder={setEditFolder}
            unread={unread}
          />
          {session && (
            <div class="m-push">
              <SessionPane me={me} session={session} folders={folders} narrow onBack={back} />
            </div>
          )}
        </>
      ) : (
        <>
          <Sidebar
            me={me}
            hostBanner={hostBanner}
            sessions={sessions || []}
            folders={folders}
            onEditFolder={setEditFolder}
            unread={unread}
            alerts={alerts}
            onToggleAlerts={toggleAlerts}
            current={current}
            onPick={pick}
            onNew={() => setModal('new')}
            onAdmin={() => setModal('admin')}
            onPassword={() => setModal('password')}
            onTokens={() => setModal('tokens')}
            onLogout={logout}
          />
          {session ? (
            <SessionPane me={me} session={session} folders={folders} narrow={false} onBack={() => setCurrent(null)} />
          ) : (
            <section class="pane placeholder">
              <p class="dim">{sessions === null ? '加载中…' : '从左侧选择一个会话，或新建一个。'}</p>
            </section>
          )}
        </>
      )}
      <Toasts
        list={toasts}
        onOpen={(n) => {
          setToasts((t) => t.filter((x) => x.n.sessionId !== n.sessionId));
          pick(n.sessionId);
        }}
        onClose={(key) => setToasts((t) => t.filter((x) => x.key !== key))}
      />
      {editFolder !== undefined && <FolderModal folder={editFolder} onClose={() => setEditFolder(undefined)} />}
      {modal === 'menu' && <MenuSheet me={me} onClose={() => setModal(null)} onAdmin={() => setModal('admin')} onPassword={() => setModal('password')} onTokens={() => setModal('tokens')} onLogout={logout} />}
      {modal === 'new' && (
        <NewSession
          me={me}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            setModal(null);
            pick(id);
          }}
        />
      )}
      {modal === 'admin' && <AdminModal me={me} onClose={() => setModal(null)} />}
      {modal === 'password' && <PasswordModal onClose={() => setModal(null)} />}
      {modal === 'tokens' && <TokensModal onClose={() => setModal(null)} />}
    </div>
  );
}

function App() {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => {
    api<Me>('GET', '/_tw/api/me').then(setMe, () => setMe(false));
    const out = () => setMe(false);
    addEventListener('tw:logout', out);
    return () => removeEventListener('tw:logout', out);
  }, []);
  if (me === null) return null;
  if (me === false) return <Login onLogin={setMe} />;
  return <Shell me={me} onLogout={() => setMe(false)} />;
}

// iOS doesn't shrink the layout when the keyboard opens; size the app to the visible viewport
// so the input box stays above the keyboard.
const vv = window.visualViewport;
if (vv && coarsePointer) {
  const fitViewport = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  fitViewport();
}

render(<App />, document.getElementById('app')!);
