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
create table if not exists auth_tokens (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at integer not null
);
`);

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
  setTranscript: db.prepare('update sessions set agent_session_id = ?, transcript_path = ? where id = ?'),

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
