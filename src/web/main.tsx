import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type ChatItem, type Group, type HostInfo, type Me, type Page, type SessionInfo, type Status } from './api';
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
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setErr('');
    try {
      onLogin(await api<Me>('POST', '/_tw/api/login', { username: f.get('username'), password: f.get('password') }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <form onSubmit={submit} class="card">
        <h1>tmux-web</h1>
        <label>
          账号
          <input name="username" autocomplete="username" autocapitalize="off" required autofocus />
        </label>
        <label>
          密码
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        {err && <p class="error">{err}</p>}
        <button class="primary" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
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

function Message({ it, onExpand }: { it: ChatItem; onExpand: (it: ChatItem) => void }) {
  const more = it.truncated && (
    <button class="link" onClick={() => onExpand(it)}>
      展开全文
    </button>
  );
  if (it.role === 'user')
    return (
      <div class="msg user">
        <div class="bubble">
          {it.text}
          {more}
        </div>
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

/** A message sent from this page that hasn't shown up in the agent's log yet. */
interface Pending {
  key: number;
  text: string;
  sent: boolean;
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function ChatView({ session }: { session: SessionInfo }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  // shown right away when you press send; removed once the agent's log has the message
  const [pending, setPending] = useState<Pending[]>([]);
  const [page, setPage] = useState<{ start: number; hasMore: boolean; pending: boolean } | null>(null);
  const [state, setState] = useState<{ status: Status; preview: string; error?: string }>({ status: session.status, preview: '' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const id = session.id;
  // bumped when the agent switches to another conversation (/clear): start over
  const [generation, setGeneration] = useState(0);

  // initial page (tail of the log), then the live stream from where it ended
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    setItems([]);
    setPage(null);
    setError('');
    stick.current = true;
    api<Page>('GET', `/_tw/api/sessions/${id}/messages?limit=30`)
      .then((p) => {
        if (cancelled) return;
        setItems(p.items);
        setPage({ start: p.start, hasMore: p.hasMore, pending: !!p.pending });
        // resume from the last byte offset we have when the stream has to be reopened
        let offset = p.end;
        stop = liveStream(
          () => `/_tw/api/sessions/${id}/stream?from=${offset}`,
          {
            msg: (fresh: ChatItem[], ev) => {
              if (ev.lastEventId) offset = Number(ev.lastEventId);
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
            state: setState,
            reset: () => setGeneration((g) => g + 1),
          },
          setOnline,
        );
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [id, generation]);

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
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, state.preview, state.status]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 200 && page?.hasMore && !loadingOlder) loadOlder();
  };

  const blocks = useMemo(() => groupItems(items), [items]);
  const live = (state.status === 'busy' || state.status === 'waiting') && state.preview;

  return (
    <div class="chat">
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
          {blocks.map((b) => (b.kind === 'tools' ? <ToolGroup key={b.items[0].id} items={b.items} onExpand={expand} /> : <Message key={b.it.id} it={b.it} onExpand={expand} />))}
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

function Composer({ sessionId, status, onPending }: { sessionId: number; status: Status; onPending: (text: string) => (ok: boolean) => void }) {
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

  // optimistic: clear the box and show the message at once, the request runs behind it
  const send = async () => {
    const msg = text;
    if (!msg.trim() || sending) return;
    setSending(true);
    setErr('');
    update('');
    const done = onPending(msg);
    try {
      await api('POST', `/_tw/api/sessions/${sessionId}/input`, { text: msg });
      done(true);
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !coarse) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div class="composer">
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
      <div class="input-row">
        {coarse && (
          <button class={`icon-btn ${keysOpen ? 'on' : ''}`} aria-label="快捷键" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowKeys((v) => !v)}>
            <Icon.keys />
          </button>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={coarse ? '输入消息' : '输入消息，Enter 发送，Shift+Enter 换行'}
          onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <button class={`primary send ${coarse ? 'round' : ''}`} aria-label="发送" onMouseDown={(e) => e.preventDefault()} onClick={send} disabled={sending || !text.trim()}>
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

function SessionSettings({ me, session, onClose }: { me: Me; session: SessionInfo; onClose: () => void }) {
  const [err, setErr] = useState('');
  const groups = useGroups(me);
  const owner = me.role === 'admin' || session.owner === me.username;
  const save = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    try {
      await api('PATCH', `/_tw/api/sessions/${session.id}`, { name: f.name, groupId: f.groupId ? Number(f.groupId) : null, share: f.groupId ? f.share : 'none' });
      onClose();
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
          <>
            <label>
              名称
              <input name="name" defaultValue={session.name} maxLength={60} />
            </label>
            <ShareFields groups={groups} groupId={session.groupId} share={session.share === 'none' ? 'view' : session.share} />
            <button class="primary">保存</button>
          </>
        )}
        {err && <p class="error">{err}</p>}
        <div class="row-actions">
          {session.access === 'control' && (
            <button type="button" onClick={restart}>
              重启
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

function Sidebar(props: { me: Me; hostBanner: boolean; sessions: SessionInfo[]; current: number | null; onPick: (id: number) => void; onNew: () => void; onAdmin: () => void; onPassword: () => void; onLogout: () => void }) {
  const { me, sessions, current } = props;
  const multiHost = new Set(sessions.map((s) => s.hostId)).size > 1;
  return (
    <aside class="sidebar">
      <div class="side-head">
        <span class="brand">tmux-web</span>
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
        {sessions.map((s) => (
          <button key={s.id} class={`session-item ${s.id === current ? 'active' : ''}`} onClick={() => props.onPick(s.id)}>
            <span class={`dot ${s.status}`} title={STATUS_LABEL[s.status]} />
            <span class="s-main">
              <span class="s-name">{s.name}</span>
              <span class="s-sub">
                {AGENT_LABEL[s.agent]}
                {multiHost ? ` · ${s.host}` : ''}
                {s.owner !== me.username ? ` · ${s.owner}` : ''}
                {s.access === 'view' ? ' · 只读' : ''}
              </span>
            </span>
          </button>
        ))}
        {!sessions.length && <p class="dim small pad">还没有会话，点「新建」开始。</p>}
      </nav>
      <div class="side-foot">
        <span class="dim small">{me.username}</span>
        <span class="spacer" />
        {me.role === 'admin' && (
          <button class="ghost small" onClick={props.onAdmin}>
            账号
          </button>
        )}
        <button class="ghost small" onClick={props.onPassword}>
          密码
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

function SessionPane({ me, session, narrow, onBack }: { me: Me; session: SessionInfo; narrow: boolean; onBack: () => void }) {
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
      {tab === 'chat' && <ChatView key={session.id} session={session} />}
      {tab === 'term' && <TerminalView key={session.id} sessionId={session.id} canWrite={session.access === 'control'} />}
      {tab === 'preview' && <PreviewView key={session.id} session={session} />}
      {settings && <SessionSettings me={me} session={session} onClose={() => setSettings(false)} />}
    </section>
  );
}

/** Shorten a path for small screens: the last two segments. */
const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
};

/** Phone home screen: session cards, a floating + button, account menu. */
function MobileHome(props: { me: Me; sessions: SessionInfo[] | null; hostBanner: boolean; onPick: (id: number) => void; onNew: () => void; onMenu: () => void; onAdmin: () => void }) {
  const { sessions } = props;
  const multiHost = new Set((sessions || []).map((s) => s.hostId)).size > 1;
  // sessions waiting for a decision first, then the busy ones
  const order: Record<string, number> = { waiting: 0, busy: 1 };
  const sorted = [...(sessions || [])].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
  return (
    <section class="m-home">
      <header class="m-head">
        <h1>会话</h1>
        <button class="icon-btn" onClick={props.onMenu} aria-label="我的">
          <Icon.user />
        </button>
      </header>
      {props.hostBanner && (
        <button class="host-banner" onClick={props.onAdmin}>
          有主机连不上，点此查看
        </button>
      )}
      <div class="m-list">
        {sessions === null && <p class="dim pad">加载中…</p>}
        {sessions?.length === 0 && <p class="dim pad">还没有会话，点右下角 ＋ 新建，或导入已有的 tmux 会话。</p>}
        {sorted.map((s) => (
          <button key={s.id} class={`m-card ${s.status}`} onClick={() => props.onPick(s.id)}>
            <span class={`m-badge ${s.agent}`}>{AGENT_LABEL[s.agent].slice(0, 1)}</span>
            <span class="m-main">
              <span class="m-name">{s.name}</span>
              <span class="m-sub">
                {multiHost ? `${s.host} · ` : ''}
                {shortPath(s.cwd)}
                {s.owner !== props.me.username ? ` · ${s.owner}` : ''}
              </span>
            </span>
            <span class={`m-status ${s.status}`}>
              <span class={`dot ${s.status}`} />
              {STATUS_LABEL[s.status]}
            </span>
          </button>
        ))}
      </div>
      <button class="fab" onClick={props.onNew} aria-label="新建会话">
        <Icon.plus />
      </button>
    </section>
  );
}

function MenuSheet({ me, onClose, onAdmin, onPassword, onLogout }: { me: Me; onClose: () => void; onAdmin: () => void; onPassword: () => void; onLogout: () => void }) {
  return (
    <Modal title={me.username} onClose={onClose}>
      <div class="sheet-list">
        {me.role === 'admin' && <button onClick={onAdmin}>主机、账号与分组</button>}
        <button onClick={onPassword}>修改密码</button>
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
  const [modal, setModal] = useState<'new' | 'admin' | 'password' | 'menu' | null>(null);
  const [hostBanner, setHostBanner] = useState(false);
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
          status: ({ id, status }) => setSessions((cur) => cur && cur.map((s) => (s.id === id ? { ...s, status } : s))),
        },
        // a 401 also ends up as an error: confirm the login is still valid
        (ok) => ok || api('GET', '/_tw/api/me').catch(() => {}),
      ),
    [],
  );

  const session = sessions?.find((s) => s.id === current) ?? null;
  const pick = (id: number) => setCurrent(id);
  const logout = async () => {
    await api('POST', '/_tw/api/logout').catch(() => {});
    onLogout();
  };

  useEffect(() => {
    document.title = session ? `${session.status === 'waiting' ? '⚠ ' : ''}${session.name} · tmux-web` : 'tmux-web';
  }, [session?.name, session?.status]);

  return (
    <div class="app">
      {narrow ? (
        session ? (
          <SessionPane me={me} session={session} narrow onBack={() => setCurrent(null)} />
        ) : (
          <MobileHome me={me} sessions={sessions} hostBanner={hostBanner} onPick={pick} onNew={() => setModal('new')} onMenu={() => setModal('menu')} onAdmin={() => setModal('admin')} />
        )
      ) : (
        <>
          <Sidebar
            me={me}
            hostBanner={hostBanner}
            sessions={sessions || []}
            current={current}
            onPick={pick}
            onNew={() => setModal('new')}
            onAdmin={() => setModal('admin')}
            onPassword={() => setModal('password')}
            onLogout={logout}
          />
          {session ? (
            <SessionPane me={me} session={session} narrow={false} onBack={() => setCurrent(null)} />
          ) : (
            <section class="pane placeholder">
              <p class="dim">{sessions === null ? '加载中…' : '从左侧选择一个会话，或新建一个。'}</p>
            </section>
          )}
        </>
      )}
      {modal === 'menu' && <MenuSheet me={me} onClose={() => setModal(null)} onAdmin={() => setModal('admin')} onPassword={() => setModal('password')} onLogout={logout} />}
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
