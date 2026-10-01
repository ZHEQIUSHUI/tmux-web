import { useEffect, useMemo, useState } from 'preact/hooks';
import { type Status } from './api';

export const STATUS_LABEL: Record<Status, string> = { starting: '连接中', idle: '空闲', busy: '运行中', waiting: '等待确认', offline: '主机离线', dead: '已停止' };
export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', bash: 'Shell' } as const;

export const store = {
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

export const coarsePointer = matchMedia('(pointer: coarse)').matches;

/**
 * EventSource that survives phones: the browser gives up on some errors, and after a phone
 * sleeps a stream can look open while being dead. Reopen when closed, when the server's
 * heartbeat stops arriving, and whenever the page becomes visible or the network comes back.
 */
export function liveStream(url: () => string, handlers: Record<string, (data: any, ev: MessageEvent) => void>, onLink?: (ok: boolean) => void) {
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

export type ThemePref = 'auto' | 'light' | 'dark';
export const THEME_LABEL: Record<ThemePref, string> = { auto: '跟随系统', light: '浅色', dark: '深色' };
export const darkMq = matchMedia('(prefers-color-scheme: dark)');

/** Apply a theme preference: data-theme on <html>, and the browser bar color on phones. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'auto') delete root.dataset.theme;
  else root.dataset.theme = pref;
  const dark = pref === 'dark' || (pref === 'auto' && darkMq.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111317' : '#f6f6f4');
}
export const savedTheme = (): ThemePref => (store.get('tw:theme') as ThemePref) || 'auto';
applyTheme(savedTheme());
darkMq.addEventListener('change', () => applyTheme(savedTheme()));

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
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

/** Phone layout (list → session navigation) below this width. */
export function useNarrow() {
  const mq = useMemo(() => matchMedia('(max-width: 760px)'), []);
  const [narrow, setNarrow] = useState(mq.matches);
  useEffect(() => {
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return narrow;
}

export function useHashSession(): [number | null, (id: number | null) => void] {
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
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** Short relative time for lists. */
export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}天前`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

/** Shorten a path for small screens: the last two segments. */
export const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
};
