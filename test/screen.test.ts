import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen } from '../src/server/screen.js';

/** Draw lines (with optional SGR codes) on a fresh 100x20 screen. */
async function screen(lines: string[]) {
  const s = new Screen(100, 20);
  s.write(Buffer.from('\x1b[H\x1b[2J' + lines.join('\r\n')));
  await s.flush();
  return s;
}
const SEP = '─'.repeat(60);

test('idle Claude: footer mode, no update, no background', async () => {
  const s = await screen(['● done', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent']);
  const a = s.analyze();
  assert.equal(a.status, 'idle');
  assert.equal(a.mode, 'auto');
  assert.equal(a.update, false);
  assert.equal(a.background, '');
});

test('busy Claude with background tasks', async () => {
  const s = await screen(['✻ Working…', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · esc to interrupt · ← 1 agent']);
  const a = s.analyze();
  assert.equal(a.status, 'busy');
  assert.equal(a.mode, 'bypassPermissions');
  assert.equal(a.background, '1 shell, 1 monitor');
});

test('permission prompt is "waiting"', async () => {
  const s = await screen(['Do you want to proceed?', '❯ 1. Yes', '  2. No']);
  assert.equal(s.analyze().status, 'waiting');
});

test('update notice above the input box', async () => {
  const s = await screen(['                     ✔ Update installed · Restart to update', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on']);
  assert.equal(s.analyze().update, true);
  // talking about it in the conversation is not a notice
  const t = await screen(['❯ the docs say restart to update', '● ok', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on']);
  assert.equal(t.analyze().update, false);
});

test('input box: typed text counts, dim placeholder does not', async () => {
  assert.equal((await screen([SEP, '❯ some draft', SEP])).hasPromptInput(), true);
  assert.equal((await screen([SEP, '❯ \x1b[2mTry "fix lint errors"\x1b[0m', SEP])).hasPromptInput(), false);
  assert.equal((await screen([SEP, '❯ ', SEP])).hasPromptInput(), false);
});

test('busy in a narrow window: footer has no "esc to interrupt", the spinner line still says so', async () => {
  const s = await screen(['  Inspecting files', '* Envisioning… (3m 36s · ↓ 18.3k tokens)', '  ⎿  Tip: Use /btw to ask', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ← 1']);
  assert.equal(s.analyze().status, 'busy');
  // a finished turn is not busy
  const done = await screen(['● all done', '✻ Crunched for 4s · done 3:23 PM', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on']);
  assert.equal(done.analyze().status, 'idle');
});

test('choices: AskUserQuestion with descriptions and an option after a rule', async () => {
  const s = await screen(['←  ☐ 颜色  ☐ 水果  ✔ Submit  →', '喜欢什么颜色？', '❯ 1. 红', '     红色', '  2. 蓝', '     蓝色', '  3. Type something.', SEP, '  4. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  const a = s.analyze();
  assert.equal(a.status, 'waiting');
  assert.deepEqual(a.choices, {
    question: '喜欢什么颜色？',
    options: [
      { n: 1, label: '红', selected: true },
      { n: 2, label: '蓝', selected: false },
      { n: 3, label: 'Type something.', selected: false },
      { n: 4, label: 'Chat about this', selected: false },
    ],
  });
});

test('choices: permission prompt; numbered text above is not a menu', async () => {
  const s = await screen(['Steps:', '1. build', '2. test', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again', '  3. No', '', 'Esc to cancel']);
  const c = s.analyze().choices!;
  assert.equal(c.question, 'Do you want to proceed?');
  assert.deepEqual(c.options.map((o) => o.label), ['Yes', "Yes, and don't ask again", 'No']);
  // not waiting: no menu
  const idle = await screen(['1. build', '2. test', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on']);
  assert.equal(idle.analyze().choices, null);
});

test('queued messages mean a turn is running even when a narrow footer drops the busy marker', async () => {
  const s = await screen(['  AIxF/z9t/3x/8AXo/4RiL', '', '❯ 感觉pid效果更好', '  ctrl+x ctrl+s to send now', SEP, '❯ Press up to edit queued messages', SEP, '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · …']);
  assert.equal(s.analyze().status, 'busy');
});
