import type { SessionInfo } from './api';
import { store } from './storage';

// The last session list seen by this browser. It is shown immediately after login while the
// event stream opens, then replaced by the authoritative list from the server.

const VERSION = 1;
const MAX_AGE = 24 * 60 * 60 * 1000;

interface Snapshot {
  v: number;
  at: number;
  list: SessionInfo[];
}

const key = (userId: number) => `tw:sessions:${userId}`;

const sane = (s: any): s is SessionInfo =>
  !!s &&
  typeof s.id === 'number' &&
  typeof s.name === 'string' &&
  (s.agent === 'claude' || s.agent === 'codex' || s.agent === 'bash') &&
  typeof s.status === 'string' &&
  typeof s.activityAt === 'number';

/** Parse a stored list, discarding old or malformed snapshots. */
export function parseSessionSnapshot(raw: string | null, now = Date.now()): SessionInfo[] | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Snapshot>;
    if (s.v !== VERSION || typeof s.at !== 'number' || now - s.at > MAX_AGE || !Array.isArray(s.list)) return null;
    return s.list.filter(sane);
  } catch {
    return null;
  }
}

export function serializeSessionSnapshot(list: SessionInfo[], now = Date.now()): string {
  return JSON.stringify({ v: VERSION, at: now, list } satisfies Snapshot);
}

export function readSessionSnapshot(userId: number): SessionInfo[] | null {
  return parseSessionSnapshot(store.get(key(userId)));
}

export function saveSessionSnapshot(userId: number, list: SessionInfo[]) {
  store.set(key(userId), serializeSessionSnapshot(list));
}

export function clearSessionSnapshot(userId: number) {
  store.set(key(userId), null);
}
