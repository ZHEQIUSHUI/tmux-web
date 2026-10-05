import { useEffect, useState } from 'preact/hooks';
import { api, type Folder, type Notice, type Me, type SessionInfo, type Status } from './api';
import { AGENT_LABEL, STATUS_LABEL, ago, coarsePointer, shortPath, store } from './lib';
import { prefetchAll, prefetchChat } from './chat';
import { Chevron, Icon, Modal, ThemeCycle, ThemeSwitch } from './ui';

// ---------------- shell ----------------

// ---------------- activity: order, unread ----------------

/**
 * How far back the recent section reaches, per browser: a slider over 10-minute steps up to an
 * hour, then hours up to a day. Hidden is a separate switch, so the reach is kept for turning it back on.
 */
const RECENT_STEPS = [10, 20, 30, 40, 50, ...Array.from({ length: 24 }, (_, i) => (i + 1) * 60)];
const snap = (m: number) => RECENT_STEPS.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
const readReach = () => {
  const v = Number(store.get('tw:recent-min') ?? 60);
  return v > 0 && Number.isFinite(v) ? snap(v) : 60;
};
// "0" was how hiding used to be stored
const readHidden = () => store.get('tw:recent-off') === '1' || store.get('tw:recent-min') === '0';
const recentLabel = (m: number) => (!m ? '不显示' : m < 60 ? `${m} 分钟` : `${m / 60} 小时`);

/** The setting, shared by every list on the page: minutes, 0 = section hidden. */
export function useRecentMinutes(): [number, (m: number) => void] {
  const read = () => (readHidden() ? 0 : readReach());
  const [min, setMin] = useState(read);
  useEffect(() => {
    const on = () => setMin(read());
    addEventListener('tw:recent', on);
    return () => removeEventListener('tw:recent', on);
  }, []);
  return [
    min,
    (m) => {
      if (m) store.set('tw:recent-min', String(snap(m)));
      store.set('tw:recent-off', m ? null : '1');
      dispatchEvent(new Event('tw:recent'));
    },
  ];
}

function RecentModal({ minutes, onPick, onClose }: { minutes: number; onPick: (m: number) => void; onClose: () => void }) {
  const [reach, setReach] = useState(minutes || readReach());
  const hidden = !minutes;
  const idx = RECENT_STEPS.indexOf(reach);
  // tick labels under the slider, at their steps
  const ticks: [number, string][] = [
    [10, '10分'],
    [60, '1时'],
    [360, '6时'],
    [720, '12时'],
    [1440, '24时'],
  ];
  const at = (m: number) => `${(RECENT_STEPS.indexOf(m) / (RECENT_STEPS.length - 1)) * 100}%`;
  return (
    <Modal title="「最近」分组" onClose={onClose}>
      <p class="dim small">显示多久以内有过活动的会话。正在运行、等待确认的会话总会显示。只对这个浏览器生效。</p>
      <div class={`reach ${hidden ? 'off' : ''}`}>
        <div class="reach-value">{recentLabel(reach)}以内</div>
        <input
          type="range"
          min={0}
          max={RECENT_STEPS.length - 1}
          step={1}
          value={idx}
          disabled={hidden}
          aria-label="时间范围"
          onInput={(e) => {
            const m = RECENT_STEPS[Number((e.target as HTMLInputElement).value)];
            setReach(m);
            onPick(m); // the list follows as you slide
          }}
        />
        <div class="reach-ticks">
          {ticks.map(([m, label]) => (
            <button key={m} class="link" style={{ left: at(m) }} disabled={hidden} onClick={() => (setReach(m), onPick(m))}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label class="sheet-toggle">
        <span>不显示这个分组</span>
        <input type="checkbox" checked={hidden} onChange={(e) => onPick((e.target as HTMLInputElement).checked ? 0 : reach)} />
      </label>
    </Modal>
  );
}

/** Sessions in use lately: active within `minutes`, or working / waiting right now. */
export function recentSessions(list: SessionInfo[], minutes: number): SessionInfo[] {
  if (!minutes) return [];
  return sortSessions(list.filter((s) => s.status === 'busy' || s.status === 'waiting' || Date.now() - s.activityAt < minutes * 60_000));
}
const folderName = (s: SessionInfo, folders: Folder[]) => folders.find((f) => f.id === s.folderId)?.name ?? '未分组';

/** Waiting for you first, then running, then most recently active. */
export function sortSessions(list: SessionInfo[]): SessionInfo[] {
  const rank = (s: SessionInfo) => (s.status === 'waiting' ? 0 : s.status === 'busy' ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt);
}

/**
 * What you have seen, per session (activity time when you last looked), kept in this browser.
 * A session is unread when it did something after that.
 */
export function useUnread(sessions: SessionInfo[] | null, current: number | null): Set<number> {
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

// ---------------- in-page alerts ----------------

export const alertsEnabled = () => store.get('tw:alerts') !== 'off';

export const NOTICE_ICON: Record<Notice['kind'], string> = { waiting: '⚠', done: '✓', offline: '⚡', ended: '■' };

export function Toasts({ list, onOpen, onClose }: { list: { key: number; n: Notice }[]; onOpen: (n: Notice) => void; onClose: (key: number) => void }) {
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

export interface SessionGroup {
  folder: Folder | null;
  sessions: SessionInfo[];
}

/** Sessions by folder (folders in their order, unfiled last). Without folders: one plain group. */
export function groupByFolder(sessions: SessionInfo[], folders: Folder[]): SessionGroup[] {
  if (!folders.length) return [{ folder: null, sessions }];
  const ids = new Set(folders.map((f) => f.id));
  const groups: SessionGroup[] = folders.map((f) => ({ folder: f, sessions: sessions.filter((s) => s.folderId === f.id) }));
  groups.push({ folder: null, sessions: sessions.filter((s) => s.folderId === null || !ids.has(s.folderId)) });
  return groups;
}

/** Which folders are collapsed; remembered in this browser. "u" = the unfiled group. */
export function useCollapsed(): [Set<string>, (key: string) => void] {
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

/** A collapsible folder header: arrow, name, count, note; drop target for dragged sessions. */
export function FolderHeader(props: { group: SessionGroup; open: boolean; onToggle: () => void; onEdit?: () => void; onDropSession?: (id: number) => void; big?: boolean; label?: string }) {
  const { folder, sessions } = props.group;
  const [over, setOver] = useState(false);
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  // the two built-in groups look different from your own folders
  const kind = props.label === '最近' ? 'recent' : folder ? 'folder' : 'ungrouped';
  return (
    <div
      class={`folder-head ${props.big ? 'big' : ''} ${over ? 'drop' : ''} kind-${kind}`}
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
        <span class="folder-kind">{kind === 'recent' ? <Icon.clock /> : kind === 'ungrouped' ? <Icon.inbox /> : <Icon.folder />}</span>
        <span class="folder-name">{props.label ?? (folder ? folder.name : '未分组')}</span>
        <span class="folder-count">{sessions.length}</span>
        {/* the note: a faint aside on the title line, cut off when long (the full text: hover, or ⋯) */}
        {folder?.note && (
          <span class="folder-note" title={folder.note}>
            {folder.note.split('\n')[0]}
          </span>
        )}
        {!props.open && waiting > 0 && <span class="dot waiting" title={`${waiting} 个等待确认`} />}
      </button>
      {(folder || props.label) && props.onEdit && (
        <button class="icon-btn folder-edit" onClick={props.onEdit} aria-label="编辑文件夹">
          <Icon.more />
        </button>
      )}

    </div>
  );
}

export const moveToFolder = (sessionId: number, folderId: number | null) => api('PUT', `/_tw/api/sessions/${sessionId}/folder`, { folderId }).catch((e) => alert(e.message));

export function Sidebar(props: {
  me: Me;
  hostBanner: boolean;
  sessions: SessionInfo[];
  folders: Folder[];
  current: number | null;
  onPick: (id: number) => void;
  onNew: () => void;
  onFiles: () => void;
  filesOpen?: boolean;
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
  const [recentMin, setRecentMin] = useRecentMinutes();
  const [recentDlg, setRecentDlg] = useState(false);
  const recent = recentSessions(sessions, recentMin);
  // as on phones: keep every chat warm (and saved), fetching only sessions that did something
  const activityKey = sessions.map((x) => x.activityAt).join();
  useEffect(() => {
    const sorted = sortSessions(sessions);
    return prefetchAll([...sorted.filter((x) => props.unread.has(x.id)), ...sorted.filter((x) => !props.unread.has(x.id))]);
  }, [activityKey]);
  // the recent section: name, conversation title and which folder it lives in
  const recentItem = (s: SessionInfo) => (
    <button key={`r${s.id}`} class={`session-item ${s.id === current ? 'active' : ''}`} onPointerDown={() => prefetchChat(s)} onMouseEnter={() => prefetchChat(s)} onClick={() => props.onPick(s.id)} title={s.title || undefined}>
      <span class={`dot ${s.status}`} title={STATUS_LABEL[s.status]} />
      <span class="s-main">
        <span class="s-name">
          {s.name}
          {props.unread.has(s.id) && <span class="unread" />}
        </span>
        <span class="s-sub">
          <span class="s-folder">{folderName(s, props.folders)}</span>
          {s.title ? ` · ${s.title}` : ''}
        </span>
      </span>
      <span class="s-time">{ago(s.activityAt)}</span>
    </button>
  );
  const item = (s: SessionInfo) => (
    <button
      key={s.id}
      class={`session-item ${s.id === current ? 'active' : ''}`}
      onPointerDown={() => prefetchChat(s)}
      onMouseEnter={() => prefetchChat(s)}
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
        <button class={`icon-btn ${props.filesOpen ? 'on' : ''}`} onClick={props.onFiles} aria-label="文件浏览器" title="文件浏览器">
          <Icon.files />
        </button>
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
      {recentDlg && <RecentModal minutes={recentMin} onPick={setRecentMin} onClose={() => setRecentDlg(false)} />}
      <nav class="session-list">
        {recent.length > 0 && (
          <div class="folder kind-recent" key="recent">
            <FolderHeader label="最近" group={{ folder: null, sessions: recent }} open={!collapsed.has('r')} onToggle={() => toggle('r')} onEdit={() => setRecentDlg(true)} />
            {!collapsed.has('r') && <div class="folder-body">{recent.map(recentItem)}</div>}
          </div>
        )}
        {groups.map((g) => {
          const key = g.folder ? String(g.folder.id) : 'u';
          const open = !collapsed.has(key);
          if (!g.folder && groups.length === 1) return g.sessions.map(item);
          if (!g.folder && !g.sessions.length) return null;
          return (
            <div class={`folder ${g.folder ? 'kind-folder' : 'kind-ungrouped'}`} key={key}>
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
        <span class="dim small" title={me.username}>{me.username}</span>
        <span class="spacer" />
        <button class="ghost small" onClick={props.onToggleAlerts} title={props.alerts ? '页内提醒：开（点击关闭）' : '页内提醒：关（点击开启）'}>
          {props.alerts ? '🔔' : '🔕'}
        </button>
        <button class="ghost small" onClick={() => setRecentDlg(true)} title={`「最近」分组：${recentLabel(recentMin)}`} aria-label="「最近」分组">
          <Icon.clock />
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
        <button class="ghost small" onClick={props.onLogout} title={`退出登录（${me.username}）`}>
          退出
        </button>
      </div>
    </aside>
  );
}

/** Phone home screen: grouped session rows (iOS-style lists), search, a floating + button. */
export function MobileHome(props: {
  me: Me;
  sessions: SessionInfo[] | null;
  folders: Folder[];
  hostBanner: boolean;
  onPick: (id: number) => void;
  onNew: () => void;
  onFiles: () => void;
  filesOpen?: boolean;
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
  const [recentMin, setRecentMin] = useRecentMinutes();
  const [recentDlg, setRecentDlg] = useState(false);
  const recent = q ? [] : recentSessions(sessions || [], recentMin);
  const recentRow = (s: SessionInfo) => (
    <button key={`r${s.id}`} class={`m-row ${s.status}`} onPointerDown={() => prefetchChat(s)} onClick={() => props.onPick(s.id)}>
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
          <span class="m-folder">{folderName(s, props.folders)}</span>
          {s.title ? ` · ${s.title}` : ''}
        </span>
      </span>
      {s.status !== 'idle' ? <span class={`m-pill ${s.status}`}>{STATUS_LABEL[s.status]}</span> : <span class="m-time">{ago(s.activityAt)}</span>}
      <span class="m-chev">
        <Chevron open={false} />
      </span>
    </button>
  );
  const count = (st: Status) => (sessions || []).filter((s) => s.status === st).length;
  const summary = sessions
    ? [`${sessions.length} 个会话`, count('busy') && `${count('busy')} 个运行中`, count('waiting') && `${count('waiting')} 个等待确认`].filter(Boolean).join(' · ')
    : '';
  // warm up every session's latest messages (unread first), so opening one is instant;
  // reruns when activity changes, and only sessions that did something get fetched again
  const activityKey = (sessions || []).map((x) => x.activityAt).join();
  useEffect(() => {
    if (!sessions) return;
    const sorted = sortSessions(sessions);
    return prefetchAll([...sorted.filter((x) => props.unread.has(x.id)), ...sorted.filter((x) => !props.unread.has(x.id))]);
  }, [activityKey]);
  const row = (s: SessionInfo) => (
    <button key={s.id} class={`m-row ${s.status}`} onPointerDown={() => prefetchChat(s)} onClick={() => props.onPick(s.id)}>
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
        <button class="icon-btn" onClick={props.onFiles} aria-label="文件浏览器">
          <Icon.files />
        </button>
        <button class="icon-btn" onClick={() => props.onEditFolder(null)} aria-label="新建文件夹">
          <Icon.folderPlus />
        </button>
        <button class="icon-btn" onClick={props.onMenu} aria-label="我的">
          <Icon.user />
        </button>
      </header>
      {recentDlg && <RecentModal minutes={recentMin} onPick={setRecentMin} onClose={() => setRecentDlg(false)} />}
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
        {recent.length > 0 && (
          <div class="m-section kind-recent" key="recent">
            <FolderHeader big label="最近" group={{ folder: null, sessions: recent }} open={!collapsed.has('r')} onToggle={() => toggle('r')} onEdit={() => setRecentDlg(true)} />
            {!collapsed.has('r') && <div class="m-group">{recent.map(recentRow)}</div>}
          </div>
        )}
        {groups.map((g) => {
          const key = g.folder ? String(g.folder.id) : 'u';
          const open = q ? true : !collapsed.has(key);
          const plain = !g.folder && groups.length === 1;
          if (!g.sessions.length && (plain || !g.folder)) return null;
          return (
            <div class={`m-section ${g.folder ? 'kind-folder' : 'kind-ungrouped'}`} key={key}>
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

export function MenuSheet({ me, onClose, onAdmin, onPassword, onTokens, onLogout }: { me: Me; onClose: () => void; onAdmin: () => void; onPassword: () => void; onTokens: () => void; onLogout: () => void }) {
  const [recentMin, setRecentMin] = useRecentMinutes();
  const [recentDlg, setRecentDlg] = useState(false);
  if (recentDlg) return <RecentModal minutes={recentMin} onPick={setRecentMin} onClose={() => setRecentDlg(false)} />;
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
        <button onClick={() => setRecentDlg(true)}>
          「最近」分组<span class="check dim">{recentLabel(recentMin)}</span>
        </button>
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
