import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Host } from './host.js';

/**
 * Reverse proxy for web apps that agents start on a host: /p/<hostId>/<port>/<path> is served
 * from 127.0.0.1:<port> on that host, through the existing SSH connection.
 *
 * Apps often reference absolute paths (/assets/app.js, /api/x). Those requests carry no /p/
 * prefix, so the last proxied target is remembered in a cookie and any path tmux-web doesn't own
 * itself (everything outside /_tw/ and /) goes there.
 */

export const PREVIEW_COOKIE = 'tw_pv';
const OWN_COOKIES = new Set(['tw_sid', PREVIEW_COOKIE]);

export interface ProxyTarget {
  host: Host;
  port: number;
  /** path (with query) on the target */
  path: string;
  /** URL prefix the app is mounted at in the browser, e.g. /p/1/5173 */
  prefix: string;
}

/** Parse /p/<hostId>/<port>/rest. */
export function parsePreviewPath(pathname: string, search: string): { hostId: number; port: number; path: string } | null {
  const m = /^\/p\/(\d+)\/(\d{1,5})(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { hostId: Number(m[1]), port, path: (m[3] || '/') + search };
}

export function previewCookie(hostId: number, port: number, secure: boolean) {
  return `${PREVIEW_COOKIE}=${hostId}.${port}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function readPreviewCookie(req: IncomingMessage): { hostId: number; port: number } | null {
  const m = new RegExp(`(?:^|;\\s*)${PREVIEW_COOKIE}=(\\d+)\\.(\\d+)`).exec(req.headers.cookie || '');
  return m ? { hostId: Number(m[1]), port: Number(m[2]) } : null;
}

/** Request headers for the app: our cookies removed, Host/Origin pointing at localhost. */
function upstreamHeaders(req: IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = { ...req.headers };
  const cookies = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !OWN_COOKIES.has(c.slice(0, c.indexOf('='))));
  if (cookies.length) h.cookie = cookies.join('; ');
  else delete h.cookie;
  // dev servers (e.g. Vite) only accept localhost Host/Origin by default
  h.host = `localhost:${port}`;
  if (h.origin) h.origin = `http://localhost:${port}`;
  if (typeof h.referer === 'string') h.referer = h.referer.replace(/^https?:\/\/[^/]+(\/p\/\d+\/\d+)?/, `http://localhost:${port}`);
  h['x-forwarded-host'] = req.headers.host;
  h['x-forwarded-proto'] = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : String(req.headers['x-forwarded-proto'] || 'http');
  return h;
}

/** Response headers for the browser: embeddable in our preview frame, redirects kept inside the prefix. */
function downstreamHeaders(headers: http.IncomingHttpHeaders, t: ProxyTarget): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = { ...headers };
  delete h['x-frame-options'];
  const csp = h['content-security-policy'];
  if (typeof csp === 'string') h['content-security-policy'] = csp.replace(/frame-ancestors[^;]*;?/i, '');
  if (typeof h.location === 'string') {
    const loc = h.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${t.port}`), '');
    h.location = loc.startsWith('/') && !loc.startsWith('//') ? t.prefix + loc : loc;
  }
  const sc = h['set-cookie'];
  if (sc) h['set-cookie'] = (Array.isArray(sc) ? sc : [sc]).map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
  return h;
}

async function connectPort(t: ProxyTarget): Promise<number> {
  return t.host.forward(t.port);
}

export async function proxyHttp(req: IncomingMessage, res: ServerResponse, t: ProxyTarget, retried = false): Promise<void> {
  const localPort = await connectPort(t);
  await new Promise<void>((resolve) => {
    const up = http.request({ host: '127.0.0.1', port: localPort, method: req.method, path: t.path, headers: upstreamHeaders(req, t.port) }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.statusMessage, downstreamHeaders(ur.headers, t));
      ur.pipe(res);
      ur.on('end', resolve);
      ur.on('error', resolve);
    });
    up.on('error', async (e: NodeJS.ErrnoException) => {
      // the SSH forward may have gone away with its master connection: re-add it once
      const replayable = req.method === 'GET' || req.method === 'HEAD';
      if (!retried && replayable && e.code === 'ECONNREFUSED' && t.host.row.kind === 'ssh' && !res.headersSent) {
        t.host.dropForward(t.port);
        try {
          await proxyHttp(req, res, t, true);
        } catch {
          fail(res, t);
        }
      } else fail(res, t);
      resolve();
    });
    req.pipe(up);
  });
}

function fail(res: ServerResponse, t: ProxyTarget) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:14px system-ui;padding:24px;color:#666">` +
      `<p>连不上 ${t.host.row.name} 上的端口 <b>${t.port}</b>。</p><p>确认服务已经启动，并且监听在 127.0.0.1 或 0.0.0.0。</p></body>`,
  );
}

/** WebSocket (and any other Upgrade) passthrough, e.g. dev-server hot reload. */
export async function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, t: ProxyTarget) {
  socket.on('error', () => {});
  try {
    const localPort = await connectPort(t);
    const up = http.request({ host: '127.0.0.1', port: localPort, method: req.method, path: t.path, headers: upstreamHeaders(req, t.port) });
    up.on('upgrade', (ur, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    up.on('response', (ur) => {
      // no upgrade: relay the refusal
      socket.write(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });
    up.on('error', () => {
      t.host.dropForward(t.port);
      socket.destroy();
    });
    up.end();
  } catch {
    socket.destroy();
  }
}
