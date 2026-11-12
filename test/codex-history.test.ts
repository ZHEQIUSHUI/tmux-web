import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { agentCommand, parseCodexHistory, parseCodexProfiles } from '../src/server/sessions.js';

const id = '01a17c90-bd43-75b3-a253-8730cdc7d472';
const file = `/home/me/.codex/sessions/2026/10/27/rollout-2026-10-27T17-53-42-${id}.jsonl`;

test('codex: history reads rollout metadata, index title and last prompt', () => {
  const out = [
    `F\t${file}\t1793090000 417716`,
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/home/me/project' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧问题' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '更新的问题' }] } }),
    '@INDEX',
    JSON.stringify({ id, thread_name: '接管当前项目', updated_at: '2026-10-27T08:54:52Z' }),
    '@HIST',
    JSON.stringify({ session_id: id, ts: 1793093287, text: '最新的提问' }),
  ].join('\n');
  assert.deepEqual(parseCodexHistory(out), [
    {
      id,
      cwd: '/home/me/project',
      title: '接管当前项目',
      lastPrompt: '最新的提问',
      mtime: 1793090000_000,
      size: 417716,
    },
  ]);
});

test('codex: injected context is not shown as the latest user prompt', () => {
  const out = [
    `F\t${file}\t1793090000 10`,
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/x' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] } }),
  ].join('\n');
  const [h] = parseCodexHistory(out);
  assert.equal(h.lastPrompt, '');
  assert.equal(h.id, id);
});

test('codex: default launch args are used, Claude is unchanged', () => {
  const base = { id: 1, name: 'x', owner_id: 1, group_id: null, share: 'none', cwd: '/x', transcript_path: null, host_id: 1, tmux_socket: null, tmux_name: null, adopted: 0, note: '', created_at: 0 } as const;
  const codex = agentCommand({ ...base, agent: 'codex', agent_session_id: null, args: '' } as any, false);
  assert.match(codex, /codex --no-alt-screen --yolo/);
  assert.doesNotMatch(codex, /--profile/);
  const resumed = agentCommand({ ...base, agent: 'codex', agent_session_id: id, args: '' } as any, true);
  assert.match(resumed, new RegExp(`codex resume ${id} --no-alt-screen --yolo`));
  assert.doesNotMatch(resumed, /--profile/);
  const custom = agentCommand({ ...base, agent: 'codex', agent_session_id: id, args: '--search' } as any, true);
  assert.match(custom, new RegExp(`codex resume ${id} --no-alt-screen --search`));
  assert.doesNotMatch(custom, /--profile/);
  // asked for already: not twice
  const inline = agentCommand({ ...base, agent: 'codex', agent_session_id: null, args: '--no-alt-screen' } as any, false);
  assert.equal(inline.match(/--no-alt-screen/g)?.length, 1);
  const claude = agentCommand({ ...base, agent: 'claude', agent_session_id: id, args: '' } as any, false);
  assert.match(claude, new RegExp(`claude --session-id ${id}`));
  assert.doesNotMatch(claude, /--yolo|--profile xx/);
});

test('codex: profile files below ~/.codex are indexed and validated', () => {
  const out = ['xx\t1793150000\t470', 'work\t1793150100\t1200', 'bad name\t0\t1', '../escape\t0\t1', 'xx\t1\t2'].join('\n');
  assert.deepEqual(parseCodexProfiles(out), [
    { name: 'work', mtime: 1793150100_000, size: 1200 },
    { name: 'xx', mtime: 1000, size: 2 },
  ]);
});

test('a Codex pane gets the rollout it started, not an older one still being written', async () => {
  const { pickCodexRollout } = await import('../src/server/transcript.js');
  const pane = Date.parse('2026-10-28T11:54:51Z');
  const c = (name: string, ts: string) => ({ name, ts });
  // what 4090 had: Codex in VS Code (same folder) started before the pane and kept writing,
  // our Codex started a second after the pane, and VS Code started another thread two days later
  const list = [c('vscode-older', '2026-10-28T11:42:29Z'), c('ours', '2026-10-28T11:54:52Z'), c('vscode-later', '2026-10-30T07:10:14Z')];
  assert.equal(pickCodexRollout(list, pane)?.name, 'ours');
  // an adopted pane, Codex started in it much later: the newest after the pane
  assert.equal(pickCodexRollout([c('a', '2026-10-29T01:00:00Z'), c('b', '2026-10-29T03:00:00Z')], pane)?.name, 'b');
  assert.equal(pickCodexRollout([c('before', '2026-10-28T11:42:29Z')], pane), null);
});

test('a long Codex conversation goes on in a new part: same thread, the newest part is read', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { tmp } = await import('./helpers.js');
  const { Host } = await import('../src/server/host.js');
  const { codexThreadOf, codexTranscript } = await import('../src/server/transcript.js');
  const thread = '01a1b363-8c3c-72b3-a9de-9eac8e1a9dbf';
  const first = `rollout-2026-11-07T08-23-28-${thread}.jsonl`;
  const part = `rollout-2026-11-11T18-36-06-${thread}_01a1ca2d-e1aa-73f0-99b0-024766f6e9d2.jsonl`;
  assert.equal(codexThreadOf(`/x/${first}`), thread);
  assert.equal(codexThreadOf(`/x/${part}`), thread);
  assert.equal(codexThreadOf('/x/notes.jsonl'), null);

  const home = path.join(tmp, 'codex-home');
  const dir = path.join(home, '.codex/sessions/2026/11/11');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, first), '{}\n');
  fs.utimesSync(path.join(dir, first), 1000, 1000);
  fs.writeFileSync(path.join(dir, part), '{}\n');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const local = new Host({ id: 0, name: 'local', kind: 'local', address: '', port: 0, ssh_user: '', owner_id: null, created_at: 0 });
    assert.equal(await codexTranscript(local, thread), path.join(dir, part));
  } finally {
    process.env.HOME = oldHome;
  }

  // the history list shows the conversation once
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: '/w' } });
  const out = [`F\t/s/${first}\t1000 10`, meta, `F\t/s/${part}\t2000 20`, meta].join('\n');
  assert.deepEqual(
    parseCodexHistory(out).map((h) => [h.id, h.mtime]),
    [[thread, 2000000]],
  );
});
