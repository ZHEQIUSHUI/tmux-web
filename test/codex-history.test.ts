import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { agentCommand, parseCodexHistory } from '../src/server/sessions.js';

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
  assert.match(codex, /codex --yolo --profile xx/);
  const resumed = agentCommand({ ...base, agent: 'codex', agent_session_id: id, args: '' } as any, true);
  assert.match(resumed, new RegExp(`codex resume ${id} --yolo --profile xx`));
  const custom = agentCommand({ ...base, agent: 'codex', agent_session_id: id, args: '--search' } as any, true);
  assert.match(custom, new RegExp(`codex resume ${id} --search`));
  assert.doesNotMatch(custom, /--profile xx/);
  const claude = agentCommand({ ...base, agent: 'claude', agent_session_id: id, args: '' } as any, false);
  assert.match(claude, new RegExp(`claude --session-id ${id}`));
  assert.doesNotMatch(claude, /--yolo|--profile xx/);
});
