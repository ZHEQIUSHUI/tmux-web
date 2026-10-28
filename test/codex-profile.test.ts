import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexProfileOf, setCodexProfile } from '../src/web/codex-profile.js';

test('codex profiles: read --profile from launch args', () => {
  assert.equal(codexProfileOf('--yolo --profile xx --search'), 'xx');
  assert.equal(codexProfileOf('-p work --yolo'), 'work');
  assert.equal(codexProfileOf('--profile=fast'), 'fast');
  assert.equal(codexProfileOf('--yolo --search'), '');
});

test('codex profiles: selection replaces only the profile option', () => {
  assert.equal(setCodexProfile('--yolo --profile xx --search', 'work'), '--yolo --search --profile work');
  assert.equal(setCodexProfile('--yolo --profile xx --search', ''), '--yolo --search');
  assert.equal(setCodexProfile('--yolo', 'xx'), '--yolo --profile xx');
  assert.equal(setCodexProfile('', 'xx'), '--profile xx');
});
