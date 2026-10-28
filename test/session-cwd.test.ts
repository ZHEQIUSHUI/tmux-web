import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers.js';
import { Host } from '../src/server/host.js';
import { DEFAULT_SESSION_CWD, normalizeSessionCwd, resolveSessionCwd, suggestDirs } from '../src/server/sessions.js';

const local = () => new Host({ id: 0, name: 'local', kind: 'local', address: '', port: 0, ssh_user: '', owner_id: null, created_at: 0 });

test('session cwd: empty input falls back to ~/workspace', () => {
  assert.equal(DEFAULT_SESSION_CWD, '~/workspace');
  assert.equal(normalizeSessionCwd(''), '~/workspace');
  assert.equal(normalizeSessionCwd('   '), '~/workspace');
  assert.equal(normalizeSessionCwd(' ~/project '), '~/project');
});

test('session cwd: the default workspace is created and offered first', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'project'));
    const workspace = await resolveSessionCwd(local());
    assert.equal(workspace, fs.realpathSync(path.join(home, 'workspace')));
    assert.ok(fs.statSync(workspace).isDirectory());

    // An explicit directory is still respected.
    assert.equal(await resolveSessionCwd(local(), '~/project'), fs.realpathSync(path.join(home, 'project')));

    const dirs = await suggestDirs(local());
    assert.equal(dirs[0], path.join(home, 'workspace'));
    assert.ok(dirs.includes(home));
    assert.ok(dirs.includes(path.join(home, 'project')));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
