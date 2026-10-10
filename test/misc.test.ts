import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import './helpers.js';
import { shq } from '../src/server/host.js';
import { parsePreviewPath, readPreviewCookie, unprefixPage } from '../src/server/proxy.js';

test('shq survives a real shell for nasty input', () => {
  for (const s of [`it's`, 'a b', '$HOME', '`id`', '"q"', '\\n', '中文 ; rm -rf /']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shq(s)}`]).toString(), s);
  }
});

test('preview paths and cookie', () => {
  assert.deepEqual(parsePreviewPath('/p/1/5173/docs/a', '?x=1'), { hostId: 1, port: 5173, path: '/docs/a?x=1' });
  assert.deepEqual(parsePreviewPath('/p/2/8080', ''), { hostId: 2, port: 8080, path: '/' });
  assert.equal(parsePreviewPath('/p/1/99999/', ''), null);
  assert.equal(parsePreviewPath('/_tw/api/x', ''), null);
  assert.deepEqual(readPreviewCookie({ headers: { cookie: 'a=1; tw_pv=3.5173' } } as any), { hostId: 3, port: 5173 });
});

test('a previewed page gets its own address back before its scripts run', () => {
  const page = unprefixPage('<!doctype html><html><head><meta charset="utf-8"><script src="/assets/app.js"></script></head><body></body></html>');
  assert.ok(page.indexOf('history.replaceState') < page.indexOf('/assets/app.js'));
  assert.ok(page.startsWith('<!doctype html><html><head><script>'));
  // the regex the page runs
  const re = /location\.pathname\.replace\((\/.*?\/),''\)/.exec(page)![1];
  const strip = (p: string) => p.replace(eval(re), '') || '/';
  assert.equal(strip('/p/1/8765/'), '/');
  assert.equal(strip('/p/1/8765'), '/');
  assert.equal(strip('/p/12/5173/docs/a'), '/docs/a');
  assert.ok(unprefixPage('<p>no head</p>').startsWith('<script>'));
});

test('app downloads race their sources: the quick one wins, a wrong file never does', async () => {
  const { raceDownload, newer } = await import('../src/server/app-updates.js');
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const good = crypto.randomBytes(2 * 1024 * 1024);
  const sha = crypto.createHash('sha256').update(good).digest('hex');
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    hits[req.url!] = (hits[req.url!] || 0) + 1;
    if (req.url === '/missing') return void res.writeHead(404).end();
    if (req.url === '/wrong') return void res.end(crypto.randomBytes(good.length));
    // /slow trickles, /fast sends at once
    res.writeHead(200, { 'Content-Length': good.length });
    if (req.url === '/fast') return void res.end(good);
    let at = 0;
    const t = setInterval(() => {
      if (res.destroyed || at >= good.length) return clearInterval(t), res.end();
      res.write(good.subarray(at, (at += 16 * 1024)));
    }, 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const got = await raceDownload(['/slow', '/missing', '/fast'].map((p) => ({ url: base + p })), sha);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), sha);
    // the wrong file arrives first, fails the check, and the race goes on without it
    const again = await raceDownload(['/wrong', '/slow'].map((p) => ({ url: base + p })), sha, 64 * 1024);
    assert.equal(crypto.createHash('sha256').update(again).digest('hex'), sha);
    await assert.rejects(raceDownload([{ url: base + '/missing' }], sha));
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.ok(newer('2026.10.9.12', '2026.10.9.9') && !newer('2026.10.9.9', '2026.10.9.9'));
});
