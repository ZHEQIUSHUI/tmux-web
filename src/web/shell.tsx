import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Folder, type HostInfo, type Notice, type Me, type SessionInfo } from './api';
import { STATUS_LABEL, liveStream, quotePath, store, useHashFiles, useHashSession, useNarrow } from './lib';
import { Icon } from './ui';
import { ChatView } from './chat';
import { TerminalView } from './terminal-view';
import { AdminModal, FolderModal, NewSession, PasswordModal, SessionSettings, TokensModal, useHosts } from './dialogs';
import { MenuSheet, MobileHome, Sidebar, Toasts, alertsEnabled, recentReach, useUnread } from './lists';
import { idsOf, newViewId, place, removeView, saveView, useHashView, useViews } from './multi';
import { DropZones, MultiPane, useSessionDrag } from './multi-view';
import { PreviewView } from './preview';
import { FilesView } from './files-view';
import { StatsModal } from './stats-view';

export type Tab = 'chat' | 'term' | 'files' | 'preview';

export const VIEWS: [Tab, string, () => any][] = [
  ['chat', '对话', Icon.chat],
  ['term', '终端', Icon.term],
  ['files', '文件', Icon.folder],
  ['preview', '预览', Icon.globe],
];

type NewAt = (hostId: number, cwd: string) => void;

export function SessionPane({ me, session, folders, narrow, onBack, onNewAt, onClose }: { me: Me; session: SessionInfo; folders: Folder[]; narrow: boolean; onBack: () => void; onNewAt: NewAt; onClose?: () => void }) {
  const tabKey = `tw:tab:${session.id}`;
  const initialTab = (): Tab => (store.get(tabKey) as Tab) || (session.agent === 'bash' ? 'term' : 'chat');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState(false);
  useEffect(() => setTab(initialTab()), [session.id]);
  const pick = (t: Tab) => {
    setTab(t);
    store.set(tabKey, t);
  };
  // a path from the files tab: added to the chat's draft, then over to the chat to finish the message
  const insert = (text: string) => {
    const key = `tw:draft:${session.id}`;
    const draft = store.get(key) || '';
    store.set(key, draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text + ' ');
    pick('chat');
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
        {onClose && (
          <button class="icon-btn pane-close" onClick={onClose} aria-label="移出分屏" title="移出分屏（会话不受影响）">
            ✕
          </button>
        )}
      </header>
      {tab === 'chat' && <ChatView key={session.id} session={session} onOpenTerminal={() => pick('term')} />}
      {tab === 'term' && <TerminalView key={session.id} sessionId={session.id} canWrite={session.access === 'control'} />}
      {tab === 'files' && (
        <FilesView
          key={session.id}
          target={{
            api: `/_tw/api/sessions/${session.id}`,
            key: `s${session.id}`,
            global: false,
            // a plain path: the agent reads it when it needs to ("@path" would pull it all in at once)
            mention: session.access === 'control' && session.agent !== 'bash' ? (p) => quotePath(p || '.') : undefined,
            onInsert: insert,
            onNewHere: (dir) => onNewAt(session.hostId, dir),
          }}
        />
      )}
      {tab === 'preview' && <PreviewView key={session.id} session={session} />}
      {settings && <SessionSettings me={me} session={session} folders={folders} onClose={() => setSettings(false)} />}
    </section>
  );
}

export function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const narrow = useNarrow();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [current, setCurrent] = useHashSession();
  const [filesOpen, setFilesOpen] = useHashFiles();
  // "new session" opened from a folder in a file browser: that host and directory filled in
  const [newAt, setNewAt] = useState<{ hostId: number; cwd: string } | null>(null);
  const newSessionAt: NewAt = (hostId, cwd) => {
    setNewAt({ hostId, cwd });
    setModal('new');
  };
  const [modal, setModal] = useState<'new' | 'admin' | 'password' | 'menu' | 'tokens' | 'stats' | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  // folder being edited; null = creating one; undefined = dialog closed
  const [editFolder, setEditFolder] = useState<Folder | null | undefined>(undefined);
  const [hostBanner, setHostBanner] = useState(false);
  // split view (desktop): #/m/<id>, a layout of up to 2×2 sessions kept in this browser
  const [viewId, setViewId] = useHashView();
  const views = useViews();
  const view = !narrow && viewId ? (views.find((v) => v.id === viewId) ?? null) : null;
  const onScreen = view ? idsOf(view.grid) : current !== null ? [current] : [];
  const dragging = useSessionDrag();
  const unread = useUnread(sessions, onScreen);
  // the session list can be made wider or narrower (desktop)
  const [sideW, setSideW] = useState(() => Number(store.get('tw:side-w')) || 260);
  const resizeSide = (e: PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    let w = sideW;
    const move = (ev: PointerEvent) => setSideW((w = Math.max(200, Math.min(520, ev.clientX))));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      store.set('tw:side-w', String(Math.round(w)));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  // relative times in the lists
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // in-page alerts from the server's notifications
  const [toasts, setToasts] = useState<{ key: number; n: Notice }[]>([]);
  const [missed, setMissed] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  const onScreenRef = useRef(onScreen);
  onScreenRef.current = onScreen;
  // in-page alerts (they come on the events stream below)
  const onNotice = (n: Notice) => {
    if (!alertsEnabled()) return;
    // inside the Mac / Android app: it turns them into system notifications (when you aren't looking)
    const w = window as any;
    w.webkit?.messageHandlers?.twNotify?.postMessage(n);
    w.TwApp?.notify?.(JSON.stringify(n));
    // already looking at it
    if (!document.hidden && onScreenRef.current.includes(n.sessionId)) return;
    const key = n.id;
    setToasts((t) => [...t.filter((x) => x.n.sessionId !== n.sessionId).slice(-2), { key, n }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), n.kind === 'waiting' ? 15000 : 8000);
    if (document.hidden) setMissed((m) => m + 1);
    if (n.kind === 'waiting' || n.kind === 'done') navigator.vibrate?.(n.kind === 'waiting' ? [120, 60, 120] : 80);
  };
  useEffect(() => {
    const on = () => !document.hidden && setMissed(0);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (me.role !== 'admin' || modal) return;
    api<HostInfo[]>('GET', '/_tw/api/hosts').then((hs) => setHostBanner(hs.some((h) => h.ok === false)), () => {});
  }, [modal]);

  useEffect(
    () =>
      liveStream(
        // the in-page alerts come on this stream too (?notices=1), one connection less
        () => '/_tw/api/events?notices=1',
        {
          sessions: setSessions,
          folders: setFolders,
          status: ({ id, status }) => setSessions((cur) => cur && cur.map((s) => (s.id === id ? { ...s, status } : s))),
          activity: ({ id, at }) => setSessions((cur) => cur && cur.map((s) => (s.id === id ? { ...s, activityAt: Math.max(s.activityAt, at) } : s))),
          notice: onNotice,
        },
        // a 401 also ends up as an error: confirm the login is still valid
        (ok) => ok || api('GET', '/_tw/api/me').catch(() => {}),
      ),
    [],
  );

  const session = sessions?.find((s) => s.id === current) ?? null;
  useEffect(() => {
    if (!sessions) return;
    const reach = recentReach() * 60_000;
    for (const v of views) {
      if (v.id === viewId) continue;
      const members = idsOf(v.grid)
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionInfo => !!s);
      const recent = members.some((s) => s.status === 'busy' || s.status === 'waiting' || Date.now() - s.activityAt < reach);
      if (members.length < 2 || !recent) removeView(v.id);
    }
  }, [sessions, views.length, viewId]);
  // opened from the list: "back" is a real history step back (same as the system back gesture)
  const fromList = useRef(false);
  const pick = (id: number) => {
    fromList.current = current === null && !filesOpen;
    setCurrent(id);
  };
  const openFiles = () => {
    fromList.current = current === null && !filesOpen;
    setFilesOpen(true);
  };
  const back = () => {
    const go = () => {
      if (fromList.current) {
        fromList.current = false;
        history.back();
      } else setCurrent(null);
    };
    // phones: slide the session view out first, like the swipe does
    const pushed = document.querySelector<HTMLElement>('.m-push');
    if (!pushed || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
    pushed.style.transition = 'transform 0.18s ease-in';
    pushed.style.transform = `translateX(${pushed.clientWidth}px)`;
    setTimeout(go, 170);
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
    <div class="app" style={narrow ? undefined : { '--side-w': `${sideW}px` }}>
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
            onFiles={openFiles}
            onStats={() => setModal('stats')}
            onMenu={() => setModal('menu')}
            onAdmin={() => setModal('admin')}
            onEditFolder={setEditFolder}
            unread={unread}
          />
          {session && (
            <SwipeBack onBack={back}>
              <SessionPane me={me} session={session} folders={folders} narrow onBack={back} onNewAt={newSessionAt} />
            </SwipeBack>
          )}
          {!session && filesOpen && (
            <SwipeBack onBack={back}>
              <GlobalFiles narrow onBack={back} onNewAt={newSessionAt} />
            </SwipeBack>
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
            onMenu={() => setModal('menu')}
            current={current}
            active={onScreen}
            views={views.map((v) => ({ id: v.id, ids: idsOf(v.grid) }))}
            viewId={view?.id ?? null}
            onPickView={setViewId}
            onRemoveView={(id) => {
              removeView(id);
              if (id === viewId) setViewId(null);
            }}
            onPick={pick}
            onNew={() => setModal('new')}
            onFiles={openFiles}
            onStats={() => setModal('stats')}
            filesOpen={filesOpen}
            onAdmin={() => setModal('admin')}
            onPassword={() => setModal('password')}
            onTokens={() => setModal('tokens')}
            onLogout={logout}
          />
          <div class="side-resizer" onPointerDown={resizeSide} title="拖动调整宽度" />
          {view && sessions ? (
            <MultiPane
              me={me}
              view={view}
              sessions={sessions}
              folders={folders}
              renderPane={({ session: s, onClose }) => <SessionPane me={me} session={s} folders={folders} narrow={false} onBack={onClose!} onNewAt={newSessionAt} onClose={onClose} />}
              onSingle={(sid) => {
                removeView(view.id);
                setCurrent(sid);
              }}
            />
          ) : session ? (
            <div class="single-pane">
              <SessionPane me={me} session={session} folders={folders} narrow={false} onBack={() => setCurrent(null)} onNewAt={newSessionAt} />
              {/* drag another session in: the two side by side */}
              {dragging && (
                <DropZones
                  can={() => true}
                  onDrop={(d, sid) => {
                    const grid = place([[session.id]], session.id, d, sid);
                    if (!grid) return;
                    const id = newViewId();
                    saveView({ id, grid });
                    setViewId(id);
                  }}
                />
              )}
            </div>
          ) : filesOpen ? (
            <GlobalFiles narrow={false} onBack={() => setFilesOpen(false)} onNewAt={newSessionAt} />
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
          at={newAt}
          onClose={() => {
            setModal(null);
            setNewAt(null);
          }}
          onCreated={(id) => {
            setModal(null);
            setNewAt(null);
            pick(id);
          }}
        />
      )}
      {modal === 'admin' && <AdminModal me={me} onClose={() => setModal(null)} />}
      {modal === 'password' && <PasswordModal onClose={() => setModal(null)} />}
      {modal === 'tokens' && <TokensModal onClose={() => setModal(null)} />}
      {modal === 'stats' && <StatsModal onClose={() => setModal(null)} />}
    </div>
  );
}

/** Something under the finger that scrolls sideways itself (wide table, long code line). */
function scrollsSideways(el: Element | null, stop: Element): boolean {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

/**
 * The pushed session view, which can be swiped right to go back (like iOS): it follows the
 * finger with the list showing underneath; released far or fast enough, it slides away.
 * In the terminal (which uses touch itself) only a swipe from the left edge counts.
 */
/** The global file browser: any host you may use, from its home directory. */
function GlobalFiles({ narrow, onBack, onNewAt }: { narrow: boolean; onBack: () => void; onNewAt: NewAt }) {
  const [hosts] = useHosts();
  const [hostId, setHostId] = useState<number | null>(() => Number(store.get('tw:files:host')) || null);
  useEffect(() => {
    if (hosts?.length && !hosts.some((h) => h.id === hostId)) setHostId((hosts.find((h) => h.ok) ?? hosts[0]).id);
  }, [hosts]);
  const host = hosts?.find((h) => h.id === hostId);
  return (
    <section class="pane">
      <header class="pane-head">
        {narrow && (
          <button class="icon-btn back" onClick={onBack} aria-label="返回">
            <Icon.back />
          </button>
        )}
        <div class="title">
          <span class="t-name">文件</span>
          <span class="t-sub">{host ? `${host.name}（只读）` : '加载中…'}</span>
        </div>
        {hosts && hosts.length > 1 && (
          <select
            class="fv-host"
            value={hostId ?? ''}
            onChange={(e) => {
              const id = Number((e.target as HTMLSelectElement).value);
              setHostId(id);
              store.set('tw:files:host', String(id));
            }}
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        )}
      </header>
      {hostId !== null && <FilesView key={hostId} target={{ api: `/_tw/api/hosts/${hostId}`, key: `h${hostId}`, global: true, onNewHere: (dir) => onNewAt(hostId, dir) }} />}
      {hosts && !hosts.length && <p class="dim pad">没有可用的主机。</p>}
    </section>
  );
}

function SwipeBack({ onBack, children }: { onBack: () => void; children: any }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = el.current!;
    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let dx = 0;
    const EDGE = 28;
    const set = (x: number, animate: boolean) => {
      node.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
      node.style.transform = x ? `translateX(${x}px)` : '';
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return (start = null);
      const t = e.touches[0];
      const target = e.target as Element;
      const inTerminal = !!target.closest?.('.term-wrap');
      if (inTerminal && t.clientX > EDGE) return (start = null);
      if (!inTerminal && scrollsSideways(target, node)) return (start = null);
      // inputs keep their own gestures (moving the caret, selecting)
      if (target.closest?.('textarea, input, .acc-bar, .keys, .slash-list')) return (start = null);
      start = { x: t.clientX, y: t.clientY, t: Date.now() };
      dragging = false;
      dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const mx = t.clientX - start.x;
      const my = t.clientY - start.y;
      if (!dragging) {
        // decide once: clearly sideways to the right, otherwise leave it to scrolling
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        if (mx > 0 && mx > Math.abs(my) * 1.5) dragging = true;
        else return (start = null);
      }
      e.preventDefault();
      dx = Math.max(0, mx);
      set(dx, false);
    };
    const onEnd = () => {
      if (!start || !dragging) return (start = null);
      const speed = dx / Math.max(1, Date.now() - start.t);
      start = null;
      dragging = false;
      if (dx > node.clientWidth * 0.3 || (speed > 0.5 && dx > 40)) {
        set(node.clientWidth, true);
        setTimeout(onBack, 180);
      } else set(0, true);
    };
    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd);
    node.addEventListener('touchcancel', onEnd);
    return () => {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onEnd);
    };
  }, [onBack]);
  return (
    <div class="m-push" ref={el}>
      {children}
    </div>
  );
}
