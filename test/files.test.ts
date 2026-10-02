import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Host } from '../src/server/host.js';
import { changes, insideCwd, listDir, readPart, search } from '../src/server/files.js';

const local = new Host({ id: 0, name: 'local', kind: 'local', address: '', port: 0, ssh_user: '', owner_id: null, created_at: 0 });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-files-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.mkdirSync(path.join(dir, 'sub dir'));
  fs.writeFileSync(path.join(dir, 'sub dir', '说明.md'), '# 标题\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  return dir;
}

test('files: list, read, search, changes', async () => {
  const dir = repo();
  try {
    const top = await listDir(local, dir, '');
    assert.equal(top.dir, fs.realpathSync(dir));
    const names = top.entries.map((e) => `${e.type}:${e.name}`).sort();
    assert.deepEqual(names, ['d:.git', 'd:sub dir', 'f:a.txt', 'f:new.txt']);
    assert.deepEqual((await listDir(local, dir, 'sub dir')).entries.map((e) => e.name), ['说明.md']);
    await assert.rejects(listDir(local, dir, 'missing'), (e: any) => e.code === 3);

    const part = await readPart(local, dir, 'a.txt', 4, 3);
    assert.equal(part.size, 14);
    assert.equal(part.data.toString(), 'TWO');

    assert.deepEqual(await search(local, dir, '', '说明'), [{ dir: false, path: 'sub dir/说明.md' }]);
    assert.deepEqual(await search(local, dir, 'sub dir', '说明'), [{ dir: false, path: 'sub dir/说明.md' }]);

    const ch = (await changes(local, dir))!;
    const byPath = Object.fromEntries(ch.files.map((f) => [f.path, f]));
    assert.equal(byPath['a.txt'].status, ' M');
    assert.equal(byPath['a.txt'].added, 2);
    assert.equal(byPath['a.txt'].removed, 1);
    assert.equal(byPath['new.txt'].status, '??');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('files: only paths inside the working directory are open to viewers', () => {
  assert.ok(insideCwd('src/a.ts'));
  assert.ok(insideCwd(''));
  assert.ok(!insideCwd('/etc/passwd'));
  assert.ok(!insideCwd('~/.ssh/id_rsa'));
  assert.ok(!insideCwd('a/../../x'));
});
