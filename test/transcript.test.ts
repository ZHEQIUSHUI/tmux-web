import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cc, writeLines } from './helpers.js';
import { Host } from '../src/server/host.js';
import { claudeState, followLog, parseLine, readFull, readPage } from '../src/server/transcript.js';

const items = (o: unknown, agent: 'claude' | 'codex' = 'claude') => parseLine(agent, JSON.stringify(o), 0).map(({ role, text, tool }) => ({ role, text, ...(tool ? { tool } : {}) }));
const local = new Host({ id: 0, name: 'local', kind: 'local', address: '', port: 0, ssh_user: '', owner_id: null, created_at: 0 });

test('claude: typed user message', () => {
  assert.deepEqual(items(cc.user('你好')), [{ role: 'user', text: '你好' }]);
});

test('claude: injected notifications are system lines, not user bubbles', () => {
  const note = cc.user('<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Monitor event: "train watch"</summary>\n<event>DONE shard 2</event>\n</task-notification>', {
    origin: { kind: 'task-notification' },
    promptSource: 'system',
  });
  assert.deepEqual(items(note), [{ role: 'meta', text: '后台任务（completed）：监控「train watch」 → DONE shard 2' }]);
});

test('claude: slash command and its output, ANSI stripped', () => {
  assert.deepEqual(items(cc.user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', { origin: undefined })), [{ role: 'meta', text: '/model opus' }]);
  assert.deepEqual(items(cc.user('<local-command-stdout>Set model to \x1b[1mOpus\x1b[22m</local-command-stdout>', { origin: undefined })), [{ role: 'meta', text: 'Set model to Opus' }]);
});

test('claude: message sent while busy (queued_command attachment)', () => {
  const att = { type: 'attachment', attachment: { type: 'queued_command', prompt: '现在咋样了', commandMode: 'prompt', origin: { kind: 'human' } } };
  assert.deepEqual(items(att), [{ role: 'user', text: '现在咋样了' }]);
  // the queue bookkeeping around it must not duplicate it
  assert.deepEqual(items({ type: 'queue-operation', operation: 'enqueue', content: '现在咋样了' }), []);
});

test('claude: assistant text and tool calls; thinking dropped', () => {
  const a = cc.assistant([
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: '先看看' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
  ]);
  assert.deepEqual(items(a), [{ role: 'assistant', text: '先看看' }, { role: 'tool', tool: 'Bash', text: 'ls -la' }]);
});

test('claude: tool results are clipped, full on demand', () => {
  const long = 'x'.repeat(5000);
  const r = cc.user([{ type: 'tool_result', content: long }]);
  const [clipped] = parseLine('claude', JSON.stringify(r), 0);
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.text.length < 1000);
  const [full] = parseLine('claude', JSON.stringify(r), 0, true);
  assert.equal(full.text.length, 5000);
});

test('claude: meta and sidechain records are skipped', () => {
  assert.deepEqual(items(cc.user('x', { isMeta: true })), []);
  assert.deepEqual(items(cc.assistant([{ type: 'text', text: 'sub' }], { isSidechain: true })), []);
  assert.deepEqual(parseLine('claude', '{not json', 0), []);
});

test('codex: messages, tool calls, hidden environment context', () => {
  const r = (payload: unknown) => ({ type: 'response_item', payload });
  assert.deepEqual(items(r({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }), 'codex'), []);
  assert.deepEqual(items(r({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '列出文件' }] }), 'codex'), [{ role: 'user', text: '列出文件' }]);
  assert.deepEqual(items(r({ type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}' }), 'codex'), [{ role: 'tool', tool: 'shell', text: 'bash -lc ls' }]);
  assert.deepEqual(items(r({ type: 'function_call_output', output: '{"output":"a\\nb"}' }), 'codex'), [{ role: 'tool', tool: 'result', text: 'a\nb' }]);
});

test('readPage: newest first page, older pages chain without gaps or duplicates', async () => {
  const lines: unknown[] = [];
  for (let i = 0; i < 250; i++) lines.push(i % 2 ? cc.assistant([{ type: 'text', text: `a${i}` }]) : cc.user(`u${i}`));
  const f = writeLines('page.jsonl', lines);
  const seen: string[] = [];
  let before: number | null = null;
  for (;;) {
    const p = await readPage('claude', local, f, before, 30);
    seen.unshift(...p.items.map((i) => i.text));
    if (!p.hasMore) break;
    before = p.start;
  }
  assert.equal(seen.length, 250);
  assert.deepEqual(seen.slice(0, 3), ['u0', 'a1', 'u2']);
  assert.equal(new Set(seen).size, 250);
});

test('readPage: a line still being written is ignored; huge lines work', async () => {
  const big = 'y'.repeat(700_000); // bigger than one read chunk
  const f = writeLines('partial.jsonl', [cc.user('first'), cc.assistant([{ type: 'text', text: big }])]);
  const fs = await import('node:fs');
  fs.appendFileSync(f, '{"type":"user","message":{"role":"user","content":"half'); // no newline yet
  const p = await readPage('claude', local, f, null, 10);
  assert.deepEqual(p.items.map((i) => i.role), ['user', 'assistant']);
  assert.equal(p.end, fs.statSync(f).size - '{"type":"user","message":{"role":"user","content":"half'.length);
  const full = await readFull('claude', local, f, Number(p.items[1].id.split(':')[0]));
  assert.equal(full[0].text.length, big.length);
});

test('followLog: streams appended lines with end offsets', async () => {
  const f = writeLines('follow.jsonl', [cc.user('old')]);
  const fs = await import('node:fs');
  const start = fs.statSync(f).size;
  const got: string[] = [];
  let end = 0;
  const stop = followLog('claude', local, f, start, (its, e) => {
    got.push(...its.map((i) => i.text));
    end = e;
  });
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(f, JSON.stringify(cc.user('new 1')) + '\n' + JSON.stringify(cc.user('new 2')) + '\n');
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  stop();
  assert.deepEqual(got, ['new 1', 'new 2']);
  assert.equal(end, fs.statSync(f).size);
});

test('claudeState: model, context tokens, 1M detection', async () => {
  const usage = (n: number) => cc.assistant([{ type: 'text', text: 'ok' }], { message: { role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 5, output_tokens: 3 } } });
  const small = writeLines('state1.jsonl', [{ type: 'permission-mode', permissionMode: 'plan' }, usage(1000)]);
  assert.deepEqual(await claudeState(local, small), { model: 'claude-opus-5-5', contextTokens: 1015, contextWindow: 200_000, permissionMode: 'plan' });
  const big = writeLines('state2.jsonl', [usage(300_000)]);
  assert.equal((await claudeState(local, big)).contextWindow, 1_000_000);
});

test('images: embedded base64 is pulled out into tw-img references', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const images: import('../src/server/transcript.js').LineImage[] = [];
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `看图：\n\n![结果](data:image/png;base64,${png})` }] },
  });
  const [it] = parseLine('claude', line, 0, false, images);
  assert.equal(it.text, '看图：\n\n![结果](tw-img:0)');
  assert.deepEqual(images, [{ mime: 'image/png', data: png }]);
  // a Read of an image file comes back as an image block in the tool result
  const result = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } }] }] },
  });
  const imgs2: import('../src/server/transcript.js').LineImage[] = [];
  assert.equal(parseLine('claude', result, 0, false, imgs2)[0].text, '![图片](tw-img:0)');
  assert.equal(imgs2[0].mime, 'image/jpeg');
});

test('claude state: after /compact the context is the compacted size until the next reply', async () => {
  const usage = (n: number) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });
  const boundary = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 862324, postTokens: 13117 } };
  const f = writeLines('compact1.jsonl', [usage(862000), boundary, cc.user('summary', { isCompactSummary: true })]);
  const st = await claudeState(local, f);
  assert.equal(st.contextTokens, 13117);
  assert.equal(st.contextWindow, 1_000_000);
  const f2 = writeLines('compact2.jsonl', [usage(862000), boundary, usage(20000)]);
  assert.equal((await claudeState(local, f2)).contextTokens, 20001);
});

test('claude: pasted text (how the page sends) is shown as typed, without the wrapper', () => {
  const pasted = '\n\n<pasted_content id="19a5">\n第一行\n第二行\n</pasted_content id="19a5">\n';
  assert.deepEqual(items(cc.user(pasted)), [{ role: 'user', text: '第一行\n第二行\n' }]);
  assert.deepEqual(items(cc.user('看下这个：<pasted_content>\nerror 1\n</pasted_content>')), [{ role: 'user', text: '看下这个：error 1' }]);
});
