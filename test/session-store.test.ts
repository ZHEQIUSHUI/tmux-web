import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../src/web/api.js';
import { parseSessionSnapshot, serializeSessionSnapshot } from '../src/web/session-store.js';

const session = {
  id: 7,
  name: 'codex',
  agent: 'codex',
  cwd: '/tmp',
  hostId: 1,
  host: '本机',
  owner: 'test',
  groupId: null,
  share: 'none',
  adopted: false,
  note: '',
  folderId: null,
  tmux: null,
  access: 'control',
  status: 'idle',
  activityAt: 123,
  title: '',
} satisfies SessionInfo;

test('session list snapshot: round trip and stale/malformed data fallback', () => {
  const raw = serializeSessionSnapshot([session], 1_000);
  assert.deepEqual(parseSessionSnapshot(raw, 2_000), [session]);
  assert.equal(parseSessionSnapshot(raw, 1_000 + 2 * 24 * 60 * 60 * 1000), null);
  assert.equal(parseSessionSnapshot('{', 2_000), null);
  assert.deepEqual(parseSessionSnapshot(JSON.stringify({ v: 1, at: 1_000, list: [session, { id: 'bad' }] }), 2_000), [session]);
});
