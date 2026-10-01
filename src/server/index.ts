import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { db, groupIdsOf, q, type Agent, type HostRow, type Role, type Share, type UserRow } from './db.js';
import { clientIp, currentUser, endSession, isSecureRequest, hashPassword, loginLockedFor, recordLogin, sameOrigin, startSession, verifyLogin, verifyPassword } from './auth.js';
import { HttpError, readJson, sendJson, serveStatic, Sse } from './http.js';
import { ensureSshKey, forgetHost, getHost, publicKey } from './host.js';
import {
  accessOf,
  backend,
  createSession,
  deleteSession,
  canUseHost,
  deleteSessionsOf,
  getLive,
  hub,
  restartSession,
  restoreAll,
  sessionView,
  suggestDirs,
  updateSession,
  type Access,
} from './sessions.js';
import { followLog, readFull, readPage } from './transcript.js';
import { parsePreviewPath, previewCookie, proxyHttp, proxyUpgrade, readPreviewCookie, type ProxyTarget } from './proxy.js';

// ---------- helpers ----------

const USERNAME = /^[a-z][a-z0-9_-]{1,30}$/;
const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Space', 'BSpace', 'C-c', 'C-d', 'C-l', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, groups: groupIdsOf(u.id) };
}

function requireUser(req: IncomingMessage): UserRow {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, '未登录');
  return u;
}

function requireAdmin(req: IncomingMessage): UserRow {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  return u;
}

function sessionFor(user: UserRow, idStr: string, need: Access) {
  const row = q.sessionById.get(Number(idStr));
  const access = row ? accessOf(user, row) : 'none';
  if (!row || access === 'none') throw new HttpError(404, 'session 不存在');
  if (need === 'control' && access !== 'control') throw new HttpError(403, '只读权限');
  const live = getLive(row.id);
  if (!live) throw new HttpError(404, 'session 不存在');
  return { row, live, access };
}

function validPassword(p: unknown): string {
  if (typeof p !== 'string' || p.length < 6) throw new HttpError(400, '密码至少 6 位');
  return p;
}

// ---------- routes ----------

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void> | void;
const routes: { method: string; re: RegExp; handler: Handler }[] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), handler });

route('POST', '/_tw/api/login', async (req, res) => {
  const { username, password } = await readJson(req);
  const name = String(username || '').trim().toLowerCase();
  const ip = clientIp(req);
  const wait = loginLockedFor(name, ip);
  if (wait > 0) throw new HttpError(429, `尝试次数过多，请 ${Math.ceil(wait / 60000)} 分钟后再试`);
  const user = verifyLogin(name, String(password || ''));
  recordLogin(name, ip, !!user);
  if (!user) throw new HttpError(401, '账号或密码错误');
  startSession(req, res, user);
  sendJson(req, res, 200, publicUser(user));
});

route('POST', '/_tw/api/logout', (req, res) => {
  endSession(req, res);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/_tw/api/me', (req, res) => {
  sendJson(req, res, 200, publicUser(requireUser(req)));
});

route('POST', '/_tw/api/me/password', async (req, res) => {
  const user = requireUser(req);
  const { oldPassword, newPassword } = await readJson(req);
  if (!verifyPassword(String(oldPassword || ''), user.password_hash)) throw new HttpError(400, '原密码错误');
  const hash = hashPassword(validPassword(newPassword));
  qUpdatePassword(user.id, hash);
  sendJson(req, res, 200, { ok: true });
});

// --- sessions ---

route('GET', '/_tw/api/sessions', (req, res) => {
  sendJson(req, res, 200, sessionView(requireUser(req)));
});

route('POST', '/_tw/api/sessions', async (req, res) => {
  const user = requireUser(req);
  const b = await readJson(req);
  const agent = b.agent as Agent;
  if (!['claude', 'codex', 'bash'].includes(agent)) throw new HttpError(400, 'agent 无效');
  const host = q.hostById.get(Number(b.hostId));
  if (!host || !canUseHost(user, host)) throw new HttpError(400, '主机无效');
  const share = (['none', 'view', 'control'].includes(b.share) ? b.share : 'none') as Share;
  const groupId = b.groupId ? Number(b.groupId) : null;
  if (groupId !== null && user.role !== 'admin' && !groupIdsOf(user.id).includes(groupId)) throw new HttpError(400, '不在该分组');
  const args = String(b.args || '').replace(/[\r\n]/g, ' ').slice(0, 500);
  try {
    const row = await createSession(user, {
      name: String(b.name || '').trim().slice(0, 60),
      agent,
      hostId: host.id,
      cwd: String(b.cwd || '~').trim(),
      args,
      groupId,
      share,
    });
    sendJson(req, res, 200, { id: row.id });
  } catch (e: any) {
    throw new HttpError(500, `创建失败：${e.message}`);
  }
});

route('PATCH', '/_tw/api/sessions/:id', async (req, res, [id]) => {
  const user = requireUser(req);
  const { row } = sessionFor(user, id, 'control');
  if (row.owner_id !== user.id && user.role !== 'admin') throw new HttpError(403, '只有创建者可以修改');
  const b = await readJson(req);
  updateSession(row.id, {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : undefined,
    groupId: b.groupId === undefined ? undefined : b.groupId ? Number(b.groupId) : null,
    share: ['none', 'view', 'control'].includes(b.share) ? b.share : undefined,
  });
  sendJson(req, res, 200, { ok: true });
});

route('DELETE', '/_tw/api/sessions/:id', async (req, res, [id]) => {
  const user = requireUser(req);
  const { row } = sessionFor(user, id, 'control');
  if (row.owner_id !== user.id && user.role !== 'admin') throw new HttpError(403, '只有创建者可以删除');
  await deleteSession(row.id);
  sendJson(req, res, 200, { ok: true });
});

route('POST', '/_tw/api/sessions/:id/restart', async (req, res, [id]) => {
  const { row } = sessionFor(requireUser(req), id, 'control');
  await restartSession(row.id);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/_tw/api/sessions/:id/messages', async (req, res, [id], url) => {
  const { row, live } = sessionFor(requireUser(req), id, 'view');
  const file = row.agent === 'bash' ? null : await live.transcriptPath().catch(() => null);
  if (!file || !live.host) return sendJson(req, res, 200, { items: [], start: 0, end: 0, hasMore: false, pending: row.agent !== 'bash' });
  const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
  try {
    sendJson(req, res, 200, await readPage(row.agent, live.host, file, before, limit));
  } catch (e: any) {
    throw new HttpError(502, `读取对话记录失败：${e.message}`);
  }
});

route('GET', '/_tw/api/sessions/:id/message', async (req, res, [id], url) => {
  const { row, live } = sessionFor(requireUser(req), id, 'view');
  const file = await live.transcriptPath();
  if (!file || !live.host) throw new HttpError(404, 'no transcript');
  sendJson(req, res, 200, await readFull(row.agent, live.host, file, Number(url.searchParams.get('off'))));
});

/**
 * Live stream for one session: new chat items (event id = byte offset, so EventSource's
 * automatic reconnect resumes exactly where it left off), plus status/preview of the screen.
 * Chat items are pushed by `tail -F` on the host, not polled.
 */
route('GET', '/_tw/api/sessions/:id/stream', (req, res, [id], url) => {
  const { row, live } = sessionFor(requireUser(req), id, 'view');
  const lastId = req.headers['last-event-id'];
  const offset = Number(lastId ?? url.searchParams.get('from') ?? 0) || 0;
  let stopFollow: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const onState = (st: { status: string; preview: string }) => sse.send('state', st);
  const sse = new Sse(req, res, () => {
    if (timer) clearTimeout(timer);
    stopFollow?.();
    live.off('state', onState);
  });
  sse.send('state', { status: live.status, preview: live.preview, error: live.error });
  live.on('state', onState);
  if (row.agent === 'bash') return;

  // the log appears only after the agent's first message: look for it until it exists
  const waitForLog = async () => {
    if (sse.closed) return;
    const file = await live.transcriptPath().catch(() => null);
    const host = live.host;
    if (sse.closed) return;
    if (!file || !host) {
      timer = setTimeout(waitForLog, 2000);
      return;
    }
    stopFollow = followLog(row.agent, host, file, offset, (items, end) => sse.send('msg', items, end));
  };
  waitForLog();
});

route('POST', '/_tw/api/sessions/:id/input', async (req, res, [id]) => {
  const { live } = sessionFor(requireUser(req), id, 'control');
  const { text, submit = true } = await readJson(req);
  if (typeof text !== 'string') throw new HttpError(400, 'text required');
  if (!live.alive) throw new HttpError(409, 'session 已停止');
  if (text) await backend.paste(live.target, text);
  if (submit) {
    // give the TUI a moment to finish handling the paste before submitting
    await new Promise((r) => setTimeout(r, 120));
    await backend.keys(live.target, ['Enter']);
  }
  sendJson(req, res, 200, { ok: true });
});

route('POST', '/_tw/api/sessions/:id/keys', async (req, res, [id]) => {
  const { live } = sessionFor(requireUser(req), id, 'control');
  const { keys } = await readJson(req);
  if (!Array.isArray(keys) || !keys.length || keys.length > 20 || !keys.every((k) => ALLOWED_KEYS.has(k))) throw new HttpError(400, 'invalid keys');
  await backend.keys(live.target, keys);
  sendJson(req, res, 200, { ok: true });
});

/** Sidebar: session list + status changes. */
route('GET', '/_tw/api/events', (req, res) => {
  const user = requireUser(req);
  let visible = new Set<number>();
  const sendList = () => {
    const fresh = q.userById.get(user.id);
    if (!fresh || fresh.disabled) return;
    const list = sessionView(fresh);
    visible = new Set(list.map((s) => s.id));
    sse.send('sessions', list);
  };
  const onStatus = (id: number, status: string) => {
    if (visible.has(id)) sse.send('status', { id, status });
  };
  const sse = new Sse(req, res, () => {
    hub.off('list', sendList);
    hub.off('status', onStatus);
  });
  hub.on('list', sendList);
  hub.on('status', onStatus);
  sendList();
});

// --- admin: users & groups ---

route('GET', '/_tw/api/users', (req, res) => {
  requireAdmin(req);
  sendJson(req, res, 200, q.users.all().map(publicUser));
});

function setGroups(userId: number, groups: unknown) {
  if (!Array.isArray(groups)) return;
  q.clearUserGroups.run(userId);
  for (const g of groups) q.addUserGroup.run(userId, Number(g));
}

route('POST', '/_tw/api/users', async (req, res) => {
  requireAdmin(req);
  const b = await readJson(req);
  const username = String(b.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw new HttpError(400, '用户名需为小写字母开头，2-31 位字母数字 _ -');
  if (q.userByName.get(username)) throw new HttpError(400, '用户名已存在');
  const role = (b.role === 'admin' ? 'admin' : 'member') as Role;
  const info = q.insertUser.run(username, hashPassword(validPassword(b.password)), role, Date.now());
  const user = q.userById.get(Number(info.lastInsertRowid))!;
  setGroups(user.id, b.groups);
  sendJson(req, res, 200, publicUser(user));
});

route('PATCH', '/_tw/api/users/:id', async (req, res, [id]) => {
  const admin = requireAdmin(req);
  const user = q.userById.get(Number(id));
  if (!user) throw new HttpError(404, '用户不存在');
  const b = await readJson(req);
  if (b.password) {
    qUpdatePassword(user.id, hashPassword(validPassword(b.password)));
    q.deleteUserTokens.run(user.id);
  }
  if (b.role && user.id !== admin.id) qSetRole(user.id, b.role === 'admin' ? 'admin' : 'member');
  if (typeof b.disabled === 'boolean' && user.id !== admin.id) {
    qSetDisabled(user.id, b.disabled);
    if (b.disabled) q.deleteUserTokens.run(user.id);
  }
  setGroups(user.id, b.groups);
  hub.emit('list');
  sendJson(req, res, 200, publicUser(q.userById.get(user.id)!));
});

route('DELETE', '/_tw/api/users/:id', async (req, res, [id]) => {
  const admin = requireAdmin(req);
  const user = q.userById.get(Number(id));
  if (!user) throw new HttpError(404, '用户不存在');
  if (user.id === admin.id) throw new HttpError(400, '不能删除自己');
  await deleteSessionsOf(user.id);
  // their private hosts go with them (sessions on those are gone already)
  for (const h of q.hosts.all().filter((h) => h.owner_id === user.id)) forgetHost(h.id);
  q.deleteUser.run(user.id);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/_tw/api/groups', (req, res) => {
  requireUser(req);
  sendJson(req, res, 200, q.groups.all());
});

route('POST', '/_tw/api/groups', async (req, res) => {
  requireAdmin(req);
  const name = String((await readJson(req)).name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, '分组名不能为空');
  try {
    q.insertGroup.run(name);
  } catch {
    throw new HttpError(400, '分组已存在');
  }
  sendJson(req, res, 200, q.groups.all());
});

route('DELETE', '/_tw/api/groups/:id', (req, res, [id]) => {
  requireAdmin(req);
  q.deleteGroup.run(Number(id));
  hub.emit('list');
  sendJson(req, res, 200, q.groups.all());
});

// --- hosts ---

const HOST_NAME = /^[A-Za-z0-9._-]+$/;

function hostView(h: HostRow, withStatus: boolean) {
  const st = getHost(h.id)?.status;
  return {
    id: h.id,
    name: h.name,
    kind: h.kind,
    address: h.address,
    port: h.port,
    user: h.ssh_user,
    ownerId: h.owner_id,
    ...(withStatus && st ? { ok: st.ok, error: st.error, tmux: st.tmux, home: st.home, checkedAt: st.checkedAt } : {}),
  };
}

route('GET', '/_tw/api/hosts', (req, res) => {
  const user = requireUser(req);
  sendJson(req, res, 200, q.hosts.all().filter((h) => canUseHost(user, h)).map((h) => hostView(h, true)));
});

route('GET', '/_tw/api/hosts/:id/dirs', async (req, res, [id]) => {
  const user = requireUser(req);
  const h = q.hostById.get(Number(id));
  if (!h || !canUseHost(user, h)) throw new HttpError(404, '主机不存在');
  try {
    sendJson(req, res, 200, await suggestDirs(getHost(h.id)!));
  } catch (e: any) {
    throw new HttpError(502, e.message);
  }
});

route('GET', '/_tw/api/hosts/:id/ports', async (req, res, [id]) => {
  const user = requireUser(req);
  const h = q.hostById.get(Number(id));
  if (!h || !canUseHost(user, h)) throw new HttpError(404, '主机不存在');
  try {
    sendJson(req, res, 200, await getHost(h.id)!.listPorts());
  } catch (e: any) {
    throw new HttpError(502, e.message);
  }
});

route('POST', '/_tw/api/hosts/:id/check', async (req, res, [id]) => {
  requireAdmin(req);
  const host = getHost(Number(id));
  if (!host) throw new HttpError(404, '主机不存在');
  await host.check();
  sendJson(req, res, 200, hostView(host.row, true));
});

route('POST', '/_tw/api/hosts', async (req, res) => {
  requireAdmin(req);
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 40);
  const address = String(b.address || '').trim();
  const sshUser = String(b.user || '').trim();
  const port = Number(b.port || 22);
  if (!name) throw new HttpError(400, '名称不能为空');
  if (!HOST_NAME.test(address)) throw new HttpError(400, '地址无效');
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(sshUser)) throw new HttpError(400, 'SSH 用户名无效');
  if (!(port > 0 && port < 65536)) throw new HttpError(400, '端口无效');
  const ownerId = b.ownerId ? Number(b.ownerId) : null;
  if (ownerId !== null && !q.userById.get(ownerId)) throw new HttpError(400, '账号不存在');
  const info = q.insertHost.run(name, 'ssh', address, port, sshUser, ownerId, Date.now());
  const host = getHost(Number(info.lastInsertRowid))!;
  await host.check();
  sendJson(req, res, 200, hostView(host.row, true));
});

route('DELETE', '/_tw/api/hosts/:id', (req, res, [id]) => {
  requireAdmin(req);
  const hid = Number(id);
  if (q.hostSessionCount.get(hid)!.n > 0) throw new HttpError(400, '这台主机上还有会话，先删除它们');
  q.deleteHost.run(hid);
  forgetHost(hid);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/_tw/api/ssh-key', (req, res) => {
  requireAdmin(req);
  sendJson(req, res, 200, { publicKey: publicKey() });
});

const qUpdatePassword = (id: number, hash: string) => db.prepare('update users set password_hash = ? where id = ?').run(hash, id);
const qSetRole = (id: number, role: Role) => db.prepare('update users set role = ? where id = ?').run(role, id);
const qSetDisabled = (id: number, disabled: boolean) => db.prepare('update users set disabled = ? where id = ?').run(disabled ? 1 : 0, id);

// ---------- app preview (reverse proxy to ports on hosts) ----------

/**
 * Which proxied app a request is for: an explicit /p/<host>/<port>/... path, or — for absolute
 * paths the app uses, which tmux-web doesn't own — the app last opened in this browser.
 */
function previewTarget(req: IncomingMessage, url: URL): (ProxyTarget & { hostId: number; explicit: boolean }) | null {
  const pv = parsePreviewPath(url.pathname, url.search);
  if (pv) return { ...pv, explicit: true, host: null!, prefix: `/p/${pv.hostId}/${pv.port}` };
  if (url.pathname.startsWith('/_tw/')) return null;
  // "/" is the tmux-web page itself, except when an app inside the preview frame navigates there
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.headers['sec-fetch-dest'] !== 'iframe') return null;
  const ck = readPreviewCookie(req);
  if (!ck) return null;
  return { hostId: ck.hostId, port: ck.port, path: url.pathname + url.search, explicit: false, host: null!, prefix: `/p/${ck.hostId}/${ck.port}` };
}

/** Resolve the target's host and check the user may use it. */
function authorizePreview(req: IncomingMessage, t: ReturnType<typeof previewTarget>): ProxyTarget | null {
  const user = currentUser(req);
  if (!user || !t) return null;
  const row = q.hostById.get(t.hostId);
  if (!row || !canUseHost(user, row)) return null;
  return { ...t, host: getHost(row.id)! };
}

async function servePreview(req: IncomingMessage, res: ServerResponse, url: URL, t: NonNullable<ReturnType<typeof previewTarget>>) {
  const target = authorizePreview(req, t);
  if (!target) {
    res.writeHead(t.explicit ? 302 : 404, t.explicit ? { Location: '/' } : {});
    return void res.end();
  }
  // a navigation to /p/... makes this app the target of absolute-path requests
  const dest = req.headers['sec-fetch-dest'];
  if (t.explicit && (!dest || dest === 'document' || dest === 'iframe')) res.setHeader('Set-Cookie', previewCookie(t.hostId, t.port, isSecureRequest(req)));
  await proxyHttp(req, res, target);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  try {
    if (url.pathname.startsWith('/_tw/api/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) return await r.handler(req, res, m.slice(1), url);
      }
      throw new HttpError(404, 'not found');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    const pt = previewTarget(req, url);
    if (pt) return await servePreview(req, res, url, pt);
    res.writeHead(404).end('not found');
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(req, res, status, { error: e.message || 'error' });
    else res.end();
  }
});

// ---------- web terminal (WebSocket) ----------

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 256 } });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  const m = /^\/_tw\/api\/sessions\/(\d+)\/term$/.exec(url.pathname);
  if (!m) {
    // websockets of a proxied app (e.g. dev-server hot reload)
    const target = sameOrigin(req) ? authorizePreview(req, previewTarget(req, url)) : null;
    if (!target) return socket.destroy();
    return void proxyUpgrade(req, socket, head, target);
  }
  const user = currentUser(req);
  if (!m || !user || !sameOrigin(req)) return socket.destroy();
  let ctx;
  try {
    ctx = sessionFor(user, m[1], 'view');
  } catch {
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, ctx.live, ctx.access === 'control'));
});

/**
 * Protocol: server → client binary frames are raw terminal output (the first one is a snapshot
 * of the current screen); text frames are JSON control messages. client → server: binary = input
 * bytes, text = JSON {type:'resize', cols, rows}.
 */
function attachTerminal(ws: WebSocket, live: NonNullable<ReturnType<typeof getLive>>, canWrite: boolean) {
  let queue: Buffer[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!queue.length || ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.concat(queue));
    queue = [];
  };
  // coalesce output into ~30 fps frames
  const onData = (buf: Buffer) => {
    queue.push(buf);
    timer ??= setTimeout(flush, 33);
  };
  const onExit = () => ws.close(4000, 'exited');

  const begin = async () => {
    if (!live.screen) await live.start(true).catch(() => {});
    const screen = live.screen;
    if (!screen) return ws.close(4000, live.status === 'offline' ? 'offline' : 'exited');
    await screen.flush();
    ws.send(JSON.stringify({ type: 'hello', cols: screen.cols, rows: screen.rows, canWrite }));
    ws.send(Buffer.from(screen.snapshot()));
    live.on('data', onData);
    live.on('exit', onExit);
  };
  begin();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return canWrite && live.write(data as Buffer);
    try {
      const msg = JSON.parse(String(data));
      // lets a phone coming back from sleep check whether this socket is still alive
      if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (!canWrite) return;
      if (msg.type === 'resize') {
        const cols = Math.max(20, Math.min(400, Number(msg.cols) | 0));
        const rows = Math.max(5, Math.min(200, Number(msg.rows) | 0));
        live.resize(cols, rows);
      }
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    live.off('data', onData);
    live.off('exit', onExit);
    if (timer) clearTimeout(timer);
  });
}

// ---------- boot ----------

function bootstrap() {
  if (q.userCount.get()!.n === 0) {
    if (!config.adminPassword) {
      console.error('No accounts yet: set ADMIN_USER / ADMIN_PASSWORD to create the first admin.');
      process.exit(1);
    }
    const name = config.adminUser.toLowerCase();
    q.insertUser.run(name, hashPassword(config.adminPassword), 'admin', Date.now());
    console.log(`created admin account "${name}"`);
  }
  if (q.hosts.all().length === 0) {
    const d = config.defaultHost;
    if (d.user) q.insertHost.run(d.name, 'ssh', d.address, d.port, d.user, null, Date.now());
    else q.insertHost.run(d.name, 'local', 'localhost', 0, '', null, Date.now());
    console.log(d.user ? `added host "${d.name}" (${d.user}@${d.address}:${d.port})` : `added host "${d.name}" (local, development mode)`);
  }
}

bootstrap();
const pub = ensureSshKey();
for (const h of q.hosts.all()) {
  const host = getHost(h.id)!;
  host.check().then((st) => {
    if (st.ok) console.log(`host ${host.label}: ok (${st.tmux})`);
    else console.warn(`host ${host.label}: ${st.error}${h.kind === 'ssh' ? `\n  add this key to ~/.ssh/authorized_keys of ${h.ssh_user} on ${h.address}:\n  ${pub}` : ''}`);
  });
}
await restoreAll();
server.listen(config.port, config.host, () => {
  console.log(`tmux-web listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  // tmux sessions keep running; only our control clients go away
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
