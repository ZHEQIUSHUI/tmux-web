import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Folder, type HostInfo, type Notice, type Me, type SessionInfo } from './api';
import { STATUS_LABEL, liveStream, store, useHashSession, useNarrow } from './lib';
import { Icon } from './ui';
import { ChatView } from './chat';
import { TerminalView } from './terminal-view';
import { AdminModal, FolderModal, NewSession, PasswordModal, SessionSettings, TokensModal } from './dialogs';
import { MenuSheet, MobileHome, Sidebar, Toasts, alertsEnabled, useUnread } from './lists';
import { PreviewView } from './preview';

export type Tab = 'chat' | 'term' | 'preview';

export const VIEWS: [Tab, string, () => any][] = [
  ['chat', '对话', Icon.chat],
  ['term', '终端', Icon.term],
  ['preview', '预览', Icon.globe],
];

export function SessionPane({ me, session, folders, narrow, onBack }: { me: Me; session: SessionInfo; folders: Folder[]; narrow: boolean; onBack: () => void }) {
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

export function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
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
