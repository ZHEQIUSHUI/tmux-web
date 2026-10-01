import { EventEmitter } from 'node:events';
import { q, type UserRow } from './db.js';
import { accessOf, getLive, hub } from './sessions.js';
import { readPage } from './transcript.js';
import type { AgentStatus } from './screen.js';

/**
 * Things worth telling someone who isn't looking at the page: an agent waiting for a decision,
 * a task finished, a host gone. Derived from session status changes; the last ones are kept so
 * a client (e.g. the phone app) that was away can catch up from the last id it saw.
 */
export interface Notice {
  /** increasing across restarts (starts from the boot time) */
  id: number;
  at: number;
  sessionId: number;
  session: string;
  kind: 'waiting' | 'done' | 'offline' | 'ended';
  title: string;
  text: string;
}

const KEEP = 200;
/** a task counts as finished only once the agent stays idle this long (it pauses between tool calls) */
const DONE_AFTER_MS = 3000;

const ring: Notice[] = [];
let seq = Date.now();
export const notices = new EventEmitter();
notices.setMaxListeners(1000);

const last = new Map<number, AgentStatus>();
const doneTimers = new Map<number, NodeJS.Timeout>();

function push(n: Omit<Notice, 'id' | 'at' | 'session'>) {
  const row = q.sessionById.get(n.sessionId);
  if (!row) return;
  const notice: Notice = { id: ++seq, at: Date.now(), session: row.name, ...n };
  ring.push(notice);
  if (ring.length > KEEP) ring.shift();
  notices.emit('notice', notice);
}

/** The beginning of the agent's latest reply, for the "finished" notice. */
async function lastReply(sessionId: number): Promise<string> {
  const live = getLive(sessionId);
  if (!live?.host || live.row.agent === 'bash') return '';
  try {
    const file = await live.transcriptPath();
    if (!file) return '';
    const page = await readPage(live.row.agent, live.host, file, null, 8);
    const reply = [...page.items].reverse().find((i) => i.role === 'assistant');
    return reply ? reply.text.replace(/\s+/g, ' ').slice(0, 160) : '';
  } catch {
    return '';
  }
}

hub.on('status', (id: number, status: AgentStatus) => {
  const prev = last.get(id);
  last.set(id, status);
  clearTimeout(doneTimers.get(id));
  doneTimers.delete(id);
  // the first status after (re)start is not news
  if (prev === undefined || prev === 'starting') return;
  if (status === 'waiting' && prev !== 'waiting') {
    push({ sessionId: id, kind: 'waiting', title: '需要你确认', text: getLive(id)?.preview.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 160) ?? '' });
  } else if (status === 'idle' && (prev === 'busy' || prev === 'waiting')) {
    doneTimers.set(
      id,
      setTimeout(async () => {
        doneTimers.delete(id);
        if (getLive(id)?.status !== 'idle') return;
        push({ sessionId: id, kind: 'done', title: '任务完成', text: await lastReply(id) });
      }, DONE_AFTER_MS),
    );
  } else if (status === 'offline' && prev !== 'offline') {
    push({ sessionId: id, kind: 'offline', title: '主机离线', text: getLive(id)?.error ?? '' });
  } else if (status === 'dead' && prev !== 'dead' && prev !== 'offline') {
    push({ sessionId: id, kind: 'ended', title: '会话已结束', text: '' });
  }
});

/** Notices after `after` that this user may see (sessions they can open). */
export function noticesFor(user: UserRow, after = 0, limit = KEEP): Notice[] {
  return ring.filter((n) => n.id > after && visible(user, n)).slice(-limit);
}

export function visible(user: UserRow, n: Notice): boolean {
  const row = q.sessionById.get(n.sessionId);
  return !!row && accessOf(user, row) !== 'none';
}
