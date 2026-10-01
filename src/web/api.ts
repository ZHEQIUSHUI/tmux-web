export type Status = 'starting' | 'idle' | 'busy' | 'waiting' | 'offline' | 'dead';

export interface Me {
  id: number;
  username: string;
  role: 'admin' | 'member';
  disabled: boolean;
  groups: number[];
}

export interface SessionInfo {
  id: number;
  name: string;
  agent: 'claude' | 'codex' | 'bash';
  cwd: string;
  hostId: number;
  host: string;
  owner: string;
  groupId: number | null;
  share: 'none' | 'view' | 'control';
  adopted: boolean;
  note: string;
  /** your folder for it (folders are personal) */
  folderId: number | null;
  /** for adopted sessions: the user's tmux session (and -L socket if not default) */
  tmux: string | null;
  access: 'view' | 'control';
  status: Status;
  /** when the session last did something (ms) */
  activityAt: number;
  /** the conversation's title (Claude Code), '' if none */
  title: string;
}

/** Server-side notification (see docs/API.md) */
export interface Notice {
  id: number;
  at: number;
  sessionId: number;
  session: string;
  kind: 'waiting' | 'done' | 'offline' | 'ended';
  title: string;
  text: string;
}

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'meta';
  text: string;
  tool?: string;
  truncated?: boolean;
}

export interface Page {
  items: ChatItem[];
  start: number;
  end: number;
  hasMore: boolean;
  pending?: boolean;
}

export interface HostInfo {
  id: number;
  name: string;
  kind: 'ssh' | 'local';
  address: string;
  port: number;
  user: string;
  ownerId: number | null;
  ok?: boolean;
  error?: string;
  tmux?: string;
  home?: string;
}

export interface Folder {
  id: number;
  name: string;
  note: string;
  position: number;
}

export interface Group {
  id: number;
  name: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/_tw/api/login') window.dispatchEvent(new Event('tw:logout'));
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  }
  return data as T;
}
