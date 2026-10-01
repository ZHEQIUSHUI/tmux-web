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
  access: 'view' | 'control';
  status: Status;
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
