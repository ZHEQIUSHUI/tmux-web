import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export type Role = 'admin' | 'member';
export type Agent = 'claude' | 'codex' | 'bash';
export type Share = 'none' | 'view' | 'control';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: number;
}

export interface GroupRow {
  id: number;
  name: string;
}

/** A user's own grouping of sessions in the sidebar. */
export interface FolderRow {
  id: number;
  owner_id: number;
  name: string;
  note: string;
  position: number;
  created_at: number;
}

export interface HostRow {
  id: number;
  name: string;
  /** 'ssh': reached over SSH; 'local': commands run directly by this process (development) */
  kind: 'ssh' | 'local';
  address: string;
  port: number;
  ssh_user: string;
  /** null: every account may use it; otherwise only this account (admins: always) */
  owner_id: number | null;
  created_at: number;
}

export interface SessionRow {
  id: number;
  name: string;
  owner_id: number;
  group_id: number | null;
  share: Share;
  agent: Agent;
  agent_session_id: string | null;
  transcript_path: string | null;
  cwd: string;
  args: string;
  host_id: number;
  /** tmux server (-L) and session name; null = ours (config socket, tw-<id>) */
  tmux_socket: string | null;
  tmux_name: string | null;
  /** 1 = an existing tmux session we attached to: never resized or killed by us */
  adopted: number;
  /** free-form note shown under the name */
  note: string;
  created_at: number;
}

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, 'tmux-web.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
create table if not exists users (
  id integer primary key,
  username text unique not null,
  password_hash text not null,
  role text not null default 'member',
  disabled integer not null default 0,
  created_at integer not null
);
create table if not exists groups (
  id integer primary key,
  name text unique not null
);
create table if not exists user_groups (
  user_id integer not null references users(id) on delete cascade,
  group_id integer not null references groups(id) on delete cascade,
  primary key (user_id, group_id)
);
create table if not exists hosts (
  id integer primary key,
  name text not null,
  kind text not null default 'ssh',
  address text not null,
  port integer not null default 22,
  ssh_user text not null,
  owner_id integer references users(id) on delete cascade,
  created_at integer not null
);
create table if not exists sessions (
  id integer primary key,
  name text not null,
  owner_id integer not null references users(id) on delete cascade,
  group_id integer references groups(id) on delete set null,
  share text not null default 'none',
  agent text not null,
  agent_session_id text,
  transcript_path text,
  cwd text not null,
  args text not null default '',
  host_id integer not null references hosts(id),
  created_at integer not null
);
create table if not exists folders (
  id integer primary key,
  owner_id integer not null references users(id) on delete cascade,
  name text not null,
  note text not null default '',
  position integer not null default 0,
  created_at integer not null
);
-- which folder a session is in, per user (sessions can be shared; folders are personal)
create table if not exists session_folders (
  user_id integer not null references users(id) on delete cascade,
  session_id integer not null references sessions(id) on delete cascade,
  folder_id integer not null references folders(id) on delete cascade,
  primary key (user_id, session_id)
);
-- long-lived tokens for apps and scripts (Authorization: Bearer ...)
create table if not exists api_tokens (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  token_hash text unique not null,
  created_at integer not null,
  last_used_at integer
);
create table if not exists auth_tokens (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at integer not null
);
`);

// columns added after the first release
for (const [col, ddl] of [
  ['tmux_socket', 'alter table sessions add column tmux_socket text'],
  ['tmux_name', 'alter table sessions add column tmux_name text'],
  ['adopted', 'alter table sessions add column adopted integer not null default 0'],
  ['note', "alter table sessions add column note text not null default ''"],
]) {
  const cols = (db.prepare('pragma table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(ddl);
}

export const q = {
  userById: db.prepare<[number], UserRow>('select * from users where id = ?'),
  userByName: db.prepare<[string], UserRow>('select * from users where username = ?'),
  users: db.prepare<[], UserRow>('select * from users order by id'),
  userCount: db.prepare<[], { n: number }>('select count(*) as n from users'),
  insertUser: db.prepare(
    'insert into users (username, password_hash, role, created_at) values (?, ?, ?, ?)',
  ),
  deleteUser: db.prepare('delete from users where id = ?'),

  groups: db.prepare<[], GroupRow>('select * from groups order by name'),
  insertGroup: db.prepare('insert into groups (name) values (?)'),
  deleteGroup: db.prepare('delete from groups where id = ?'),
  groupIdsOf: db.prepare<[number], { group_id: number }>('select group_id from user_groups where user_id = ?'),
  clearUserGroups: db.prepare('delete from user_groups where user_id = ?'),
  addUserGroup: db.prepare('insert or ignore into user_groups (user_id, group_id) values (?, ?)'),

  hosts: db.prepare<[], HostRow>('select * from hosts order by id'),
  hostById: db.prepare<[number], HostRow>('select * from hosts where id = ?'),
  insertHost: db.prepare('insert into hosts (name, kind, address, port, ssh_user, owner_id, created_at) values (?, ?, ?, ?, ?, ?, ?)'),
  deleteHost: db.prepare('delete from hosts where id = ?'),
  hostSessionCount: db.prepare<[number], { n: number }>('select count(*) as n from sessions where host_id = ?'),

  sessions: db.prepare<[], SessionRow>('select * from sessions order by id'),
  sessionById: db.prepare<[number], SessionRow>('select * from sessions where id = ?'),
  insertSession: db.prepare(
    `insert into sessions (name, owner_id, group_id, share, agent, agent_session_id, cwd, args, host_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  deleteSession: db.prepare('delete from sessions where id = ?'),
  setCwd: db.prepare('update sessions set cwd = ? where id = ?'),
  insertAdopted: db.prepare(
    `insert into sessions (name, owner_id, group_id, share, agent, agent_session_id, cwd, args, host_id, tmux_socket, tmux_name, adopted, created_at)
     values (?, ?, null, 'none', ?, ?, ?, '', ?, ?, ?, 1, ?)`,
  ),
  setNote: db.prepare('update sessions set note = ? where id = ?'),

  foldersOf: db.prepare<[number], FolderRow>('select * from folders where owner_id = ? order by position, id'),
  folderById: db.prepare<[number], FolderRow>('select * from folders where id = ?'),
  insertFolder: db.prepare('insert into folders (owner_id, name, note, position, created_at) values (?, ?, ?, ?, ?)'),
  updateFolder: db.prepare('update folders set name = ?, note = ?, position = ? where id = ?'),
  deleteFolder: db.prepare('delete from folders where id = ?'),
  folderAssignments: db.prepare<[number], { session_id: number; folder_id: number }>('select session_id, folder_id from session_folders where user_id = ?'),
  assignFolder: db.prepare('insert into session_folders (user_id, session_id, folder_id) values (?, ?, ?) on conflict (user_id, session_id) do update set folder_id = excluded.folder_id'),
  unassignFolder: db.prepare('delete from session_folders where user_id = ? and session_id = ?'),

  /** an adopted session whose tmux is gone becomes one of ours */
  unadopt: db.prepare('update sessions set tmux_socket = null, tmux_name = null, adopted = 0 where id = ?'),
  setTranscript: db.prepare('update sessions set agent_session_id = ?, transcript_path = ? where id = ?'),

  apiTokenUser: db.prepare<[string], UserRow & { token_id: number }>(
    `select u.*, t.id as token_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = ? and u.disabled = 0`,
  ),
  touchApiToken: db.prepare('update api_tokens set last_used_at = ? where id = ?'),
  apiTokensOf: db.prepare<[number], { id: number; name: string; created_at: number; last_used_at: number | null }>(
    'select id, name, created_at, last_used_at from api_tokens where user_id = ? order by id',
  ),
  insertApiToken: db.prepare('insert into api_tokens (user_id, name, token_hash, created_at) values (?, ?, ?, ?)'),
  deleteApiToken: db.prepare('delete from api_tokens where id = ? and user_id = ?'),
  tokenUser: db.prepare<[string, number], UserRow>(
    `select u.* from auth_tokens t join users u on u.id = t.user_id
     where t.token_hash = ? and t.expires_at > ? and u.disabled = 0`,
  ),
  insertToken: db.prepare('insert into auth_tokens (token_hash, user_id, expires_at) values (?, ?, ?)'),
  deleteToken: db.prepare('delete from auth_tokens where token_hash = ?'),
  deleteUserTokens: db.prepare('delete from auth_tokens where user_id = ?'),
  purgeTokens: db.prepare('delete from auth_tokens where expires_at <= ?'),
};

export function groupIdsOf(userId: number): number[] {
  return q.groupIdsOf.all(userId).map((r) => r.group_id);
}
