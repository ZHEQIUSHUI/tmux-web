import type { ChatCache } from './chat';

// Chat views kept in IndexedDB, so reopening the page shows every chat at once and only what's
// new since is fetched. Per account; cleared on logout.

const DB = 'tw-chat';
const STORE = 'chats';
/** sessions kept; the least recently used go first */
export const MAX_SESSIONS = 50;
/** items kept per session (the newest); older ones load on scroll as usual */
const MAX_ITEMS = 400;

interface Rec {
  user: number;
  sid: number;
  c: ChatCache;
}

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = r.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode, storage disabled: just no persistence
    }
  });
  return dbp;
}

const done = (t: IDBTransaction) => new Promise<void>((resolve) => (t.oncomplete = t.onerror = t.onabort = () => resolve()));

let user = 0;

/** Load this account's saved chats (newest last), dropping what is over the limit. */
export async function loadChats(userId: number): Promise<[number, ChatCache][]> {
  user = userId;
  const db = await open();
  if (!db) return [];
  try {
    const t = db.transaction(STORE, 'readwrite');
    const os = t.objectStore(STORE);
    const all = await new Promise<Rec[]>((resolve) => {
      const r = os.getAll();
      r.onsuccess = () => resolve(r.result as Rec[]);
      r.onerror = () => resolve([]);
    });
    const mine = all.filter((r) => r.user === userId).sort((a, b) => a.c.at - b.c.at);
    for (const r of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS))) os.delete(key(r.user, r.sid));
    await done(t);
    return mine.slice(-MAX_SESSIONS).map((r) => [r.sid, r.c]);
  } catch {
    return [];
  }
}

const key = (u: number, sid: number) => `${u}:${sid}`;

/** Keep the newest items; the page then continues from the first one kept. */
function trim(c: ChatCache): ChatCache {
  if (c.items.length <= MAX_ITEMS) return c;
  const items = c.items.slice(-MAX_ITEMS);
  return { ...c, items, page: { ...c.page, start: Number(items[0].id.split(':')[0]), hasMore: true }, scrollTop: null };
}

const dirty = new Map<number, ChatCache | null>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Save a session's chat view (batched); null removes it. */
export function saveChat(sid: number, c: ChatCache | null) {
  if (!user) return;
  dirty.set(sid, c);
  timer ??= setTimeout(flush, 1500);
}

async function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!dirty.size || !user) return;
  const batch = [...dirty];
  dirty.clear();
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction(STORE, 'readwrite');
    const os = t.objectStore(STORE);
    for (const [sid, c] of batch) {
      if (c) os.put({ user, sid, c: trim(c) } satisfies Rec, key(user, sid));
      else os.delete(key(user, sid));
    }
    await done(t);
  } catch {
    /* quota or a closed database: the in-memory cache still works */
  }
}

// write out before the page goes away (phones kill background tabs without unload)
addEventListener('pagehide', () => void flush());
document.addEventListener('visibilitychange', () => document.hidden && void flush());

/** Forget everything saved in this browser (logout). */
export async function clearChats() {
  dirty.clear();
  user = 0;
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).clear();
    await done(t);
  } catch {
    /* nothing to clear */
  }
}
