import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath, displayName, parseAttachments } from '../src/web/attachment.js';

test('attachments: uploads and files with a directory become cards', () => {
  const r = parseAttachments('看看这个 .tmux-web/uploads/20261020010108-截图.png 和 "docs/说明.pdf"');
  assert.equal(r.text, '看看这个 和');
  assert.deepEqual(
    r.attachments.map((a) => [a.path, a.name, a.kind, a.ext]),
    [
      ['.tmux-web/uploads/20261020010108-截图.png', '截图.png', 'image', 'png'],
      ['docs/说明.pdf', '说明.pdf', 'pdf', 'pdf'],
    ],
  );
});

test('attachments: quoted paths with spaces, deduplicated', () => {
  const r = parseAttachments('"sub dir/会议 记录.md" "sub dir/会议 记录.md"');
  assert.equal(r.text, '');
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0].path, 'sub dir/会议 记录.md');
  assert.equal(r.attachments[0].kind, 'text');
});

test('attachments: a bare file name only when the message is just paths', () => {
  const alone = parseAttachments('README.md');
  assert.equal(alone.text, '');
  assert.equal(alone.attachments[0].name, 'README.md');
  const prose = parseAttachments('请看看 README.md');
  assert.equal(prose.text, '请看看 README.md');
  assert.deepEqual(prose.attachments, []);
  const code = parseAttachments('请修改 src/main.ts 里的 bug');
  assert.equal(code.text, '请修改 src/main.ts 里的 bug');
  assert.deepEqual(code.attachments, []);
});

test('attachments: URLs and Markdown links are left alone', () => {
  for (const text of ['https://example.com/a.png', '[报告](out/report.md)', '<img src="out/a.png">']) {
    const r = parseAttachments(text);
    assert.equal(r.text, text);
    assert.deepEqual(r.attachments, []);
  }
});

test('attachments: classify and name common files', () => {
  assert.equal(classifyPath('a.MP4'), 'video');
  assert.equal(classifyPath('a.flac'), 'audio');
  assert.equal(classifyPath('bundle.tar.gz'), 'archive');
  assert.equal(classifyPath('src/main.ts'), 'code');
  assert.equal(classifyPath('data.csv'), 'sheet');
  assert.equal(classifyPath('unknown.xyz'), 'other');
  assert.equal(displayName('.tmux-web/uploads/20261009084543-AXDSL_docs_zh.zip'), 'AXDSL_docs_zh.zip');
  assert.equal(displayName('normal-name.txt'), 'normal-name.txt');
});
