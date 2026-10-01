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
