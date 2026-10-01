import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { q, type UserRow } from './db.js';

const COOKIE = 'tw_sid';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

// ---- passwords (scrypt, built into node: no native dependency) ----

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// Burn the same CPU time for unknown usernames so timing doesn't reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));
export function verifyLogin(username: string, password: string): UserRow | null {
  const user = q.userByName.get(username);
  const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  return user && ok && !user.disabled ? user : null;
}

// ---- login throttling ----

interface Attempt {
  fails: number;
  lockedUntil: number;
}
const attempts = new Map<string, Attempt>();
const LIMITS = { user: 5, ip: 20 };
const LOCK_MS = 15 * 60 * 1000;

export function loginLockedFor(username: string, ip: string): number {
  const now = Date.now();
  let wait = 0;
  for (const key of [`u:${username}`, `ip:${ip}`]) {
    const a = attempts.get(key);
    if (a && a.lockedUntil > now) wait = Math.max(wait, a.lockedUntil - now);
  }
  return wait;
}

export function recordLogin(username: string, ip: string, ok: boolean) {
  const now = Date.now();
  for (const [key, limit] of [
    [`u:${username}`, LIMITS.user],
    [`ip:${ip}`, LIMITS.ip],
  ] as const) {
    if (ok) {
      attempts.delete(key);
      continue;
    }
    const a = attempts.get(key) ?? { fails: 0, lockedUntil: 0 };
    if (a.lockedUntil && a.lockedUntil <= now) a.fails = 0;
    a.fails += 1;
    if (a.fails >= limit) a.lockedUntil = now + LOCK_MS;
    attempts.set(key, a);
  }
}

// ---- cookie sessions ----

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if (config.cookieSecure !== 'auto') return config.cookieSecure === 'true';
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '?';
}

export function currentUser(req: IncomingMessage): UserRow | null {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  return q.tokenUser.get(sha256(token), Date.now()) ?? null;
}

export function startSession(req: IncomingMessage, res: ServerResponse, user: UserRow) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.purgeTokens.run(Date.now());
  q.insertToken.run(sha256(token), user.id, Date.now() + TOKEN_TTL_MS);
  res.setHeader('Set-Cookie', cookie(req, token, TOKEN_TTL_MS / 1000));
}

export function endSession(req: IncomingMessage, res: ServerResponse) {
  const token = parseCookies(req)[COOKIE];
  if (token) q.deleteToken.run(sha256(token));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}

function cookie(req: IncomingMessage, value: string, maxAge: number) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/** Reject cross-site requests: when the browser sends Origin it must match our Host. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return new URL(origin).host === String(host).split(',')[0].trim();
  } catch {
    return false;
  }
}
