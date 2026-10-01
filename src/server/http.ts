import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const acceptsGzip = (req: IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (raw.length > 1024 && acceptsGzip(req)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.writeHead(status);
    res.end(zlib.gzipSync(raw, { level: 6 }));
  } else {
    res.writeHead(status);
    res.end(raw);
  }
}

export async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

/**
 * Server-sent events. Compressed with gzip flushed per event, so a large message costs little
 * on a slow link while each event still arrives immediately.
 */
export class Sse {
  private out: NodeJS.WritableStream & { flush?: (cb?: () => void) => void };
  private heartbeat: NodeJS.Timeout;
  closed = false;

  constructor(req: IncomingMessage, res: ServerResponse, onClose: () => void) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (acceptsGzip(req)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(200);
      const gz = zlib.createGzip({ level: 6 });
      gz.pipe(res);
      this.out = gz;
    } else {
      res.writeHead(200);
      this.out = res;
    }
    this.out.write('retry: 2000\n\n');
    this.flush();
    this.heartbeat = setInterval(() => this.ping(), 20000);
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.heartbeat);
      onClose();
    };
    req.on('close', close);
    res.on('error', close);
  }

  private flush() {
    this.out.flush?.(zlib.constants.Z_SYNC_FLUSH as never);
  }

  send(event: string, data: unknown, id?: string | number) {
    if (this.closed) return;
    let s = '';
    if (id !== undefined) s += `id: ${id}\n`;
    s += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.out.write(s);
    this.flush();
  }

  /** Heartbeat. A real event (not a comment) so the page can detect a connection that died silently. */
  ping() {
    this.send('ping', 0);
  }
}

// ---------- static files ----------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves dist/web: "/" and /_tw/*. Hashed assets are immutable; build.mjs writes .br/.gz siblings. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? '/index.html' : pathname;
  if (rel !== '/index.html' && !rel.startsWith('/_tw/')) return false;
  const file = path.join(config.webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(config.webDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  const accept = String(req.headers['accept-encoding'] || '');
  let served = file;
  if (/\bbr\b/.test(accept) && fs.existsSync(file + '.br')) {
    served = file + '.br';
    res.setHeader('Content-Encoding', 'br');
  } else if (/\bgzip\b/.test(accept) && fs.existsSync(file + '.gz')) {
    served = file + '.gz';
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', rel.startsWith('/_tw/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Length', fs.statSync(served).size);
  res.writeHead(200);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(served).pipe(res);
  return true;
}
