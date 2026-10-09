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
