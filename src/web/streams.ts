import { liveStream } from './lib';

// Every chat on the page shares one live connection (/_tw/api/streams): over http a browser keeps
// only ~6 connections per site open, and a split view shows up to four chats. When the set of
// chats changes, the connection is reopened with each chat's current offset.

export interface SessionHandlers {
  msg: (items: any[], end: number) => void;
  state: (st: any) => void;
  reset: () => void;
}
interface Sub {
  /** where the chat is: byte offset reached, and which conversation log */
  pos: () => { from: number; log?: string };
  on: SessionHandlers;
  link: (ok: boolean) => void;
}

const subs = new Map<number, Sub>();
let stop: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function reopen() {
  timer = null;
  stop?.();
  stop = null;
  if (!subs.size) return;
  const url = () =>
    '/_tw/api/streams?s=' +
    [...subs]
      .map(([sid, s]) => {
        const { from, log } = s.pos();
        return `${sid}:${from}:${log ? encodeURIComponent(encodeURIComponent(log)) : ''}`;
      })
      .join(',');
  const route = (fn: (s: Sub, d: { data: any; end?: number }) => void) => (d: { sid: number; data: any; end?: number }) => {
    const s = subs.get(d.sid);
    if (s) fn(s, d);
  };
  stop = liveStream(
    url,
    {
      msg: route((s, d) => s.on.msg(d.data, d.end ?? 0)),
      state: route((s, d) => s.on.state(d.data)),
      reset: route((s) => s.on.reset()),
    },
    (ok) => subs.forEach((s) => s.link(ok)),
    { fresh: true },
  );
}
const changed = () => {
  if (!timer) timer = setTimeout(reopen, 30);
};

/** Follow a session's chat and screen state; returns the unsubscribe. */
export function followChat(sid: number, pos: Sub['pos'], on: SessionHandlers, link: (ok: boolean) => void): () => void {
  const sub = { pos, on, link };
  subs.set(sid, sub);
  changed();
  return () => {
    if (subs.get(sid) !== sub) return;
    subs.delete(sid);
    changed();
  };
}
