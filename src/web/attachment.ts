// Attachments in a chat message arrive as plain paths (uploaded files below .tmux-web/uploads,
// files picked from the host, or files dragged in from this device). There is no attachment
// metadata in the transcript, so recognise the paths that a file picker / uploader would write.

export type AttachmentKind = 'image' | 'audio' | 'video' | 'text' | 'code' | 'pdf' | 'archive' | 'document' | 'sheet' | 'slides' | 'other';

export interface Attachment {
  path: string;
  name: string;
  kind: AttachmentKind;
  ext: string;
}

export interface ParsedAttachments {
  text: string;
  attachments: Attachment[];
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff', 'heic', 'heif']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);
const PDF = new Set(['pdf']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab', 'iso', 'dmg']);
const DOCUMENT = new Set(['doc', 'docx', 'odt', 'rtf', 'pages', 'epub']);
const SHEET = new Set(['xls', 'xlsx', 'ods', 'numbers', 'csv', 'tsv']);
const SLIDES = new Set(['ppt', 'pptx', 'odp', 'key']);
const CODE = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'go', 'rs', 'py', 'rb', 'php', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'sh', 'bash', 'zsh',
  'fish', 'sql', 'graphql', 'gql', 'proto', 'vue', 'svelte', 'swift', 'kt', 'kts', 'dart', 'lua', 'r', 'pl', 'pm', 'scala', 'clj', 'ex', 'exs', 'erl', 'hrl', 'hs',
  'zig', 'nim', 'v', 'asm', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'tex', 'diff', 'patch', 'ini', 'conf', 'cfg', 'env',
]);
const TEXT = new Set(['txt', 'log', 'md', 'markdown', 'mdx', 'csv', 'tsv']);
const KNOWN = new Set([...IMAGE, ...AUDIO, ...VIDEO, ...PDF, ...ARCHIVE, ...DOCUMENT, ...SHEET, ...SLIDES, ...CODE, ...TEXT]);

const QUIET = /[\s,，。；;、:：]+/g;
const QUOTED = /"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'/g;
const UNQUOTED = /(^|\s)([^\s"'`<>()[\]{}，。；;]+)/gm;
const MARKDOWN_LINK = /!?\[((?:\\.|[^\]\\\r\n])*)\]\(\s*(?:<([^>\r\n]+)>|([^)\s]+))(?:\s+"[^"\r\n]*")?\s*\)/g;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const trimPath = (p: string) => p.replace(/^[<[{(（【]+/, '').replace(/[>\]})）】，。；;、,:：]+$/, '');
const unquote = (p: string) => p.replace(/\\(["'\\$`])/g, '$1');

/** Extension without the dot (lower case); `.env` counts as env. */
export function extensionOf(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf('.');
  return at >= 0 && at < name.length - 1 ? name.slice(at + 1).toLowerCase() : '';
}

export function classifyPath(path: string): AttachmentKind {
  const ext = extensionOf(path);
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (PDF.has(ext)) return 'pdf';
  if (ARCHIVE.has(ext)) return 'archive';
  if (DOCUMENT.has(ext)) return 'document';
  if (SHEET.has(ext)) return 'sheet';
  if (SLIDES.has(ext)) return 'slides';
  if (CODE.has(ext)) return 'code';
  if (TEXT.has(ext)) return 'text';
  return 'other';
}

/** Uploaded names carry a timestamp prefix; the original name is nicer in the chat. */
export function displayName(path: string): string {
  const name = basename(path);
  return /(?:^|\/)\.tmux-web\/uploads\//.test(path) ? name.replace(/^\d{14}-/, '') || name : name;
}

/**
 * What an uploaded file becomes in the composer. Images use a Markdown link: image syntax would
 * start with "!", which Codex and Claude treat as their shell-command shortcut.
 */
export function markdownForUpload(name: string, path: string): string {
  if (classifyPath(path) !== 'image') return path;
  const alt = name.replace(/[\\[\]]/g, '\\$&');
  const dest = path.replace(/[()]/g, '\\$&');
  return `[${alt}](${dest})`;
}

/** Old drafts may still start with image Markdown; an agent would run it as a shell command. */
export function withoutLeadingImageBang(text: string): string {
  const m = /^(\s*)!(\[((?:\\.|[^\]\\\r\n])*)\]\(\s*(?:<([^>\r\n]+)>|([^)\s]+))(?:\s+"[^"\r\n]*")?\s*\))/.exec(text);
  if (!m || !isUpload(trimPath(unquote((m[4] ?? m[5] ?? '').trim())))) return text;
  return m[1] + m[2] + text.slice(m[0].length);
}

const isUpload = (p: string) => /(?:^|\/)\.tmux-web\/uploads\/.+/.test(p);
const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^data:/i.test(p);
const hasExt = (p: string) => KNOWN.has(extensionOf(p));

function attachment(path: string): Attachment {
  return { path, name: displayName(path), kind: classifyPath(path), ext: extensionOf(path) };
}

interface Candidate {
  start: number;
  end: number;
  path: string;
  /** quoted, or a bare file name that is only accepted when the message is just paths */
  safe: boolean;
}

/**
 * Pull file paths out of a plain-text chat item. Paths with a directory (including every upload)
 * are attachments anywhere in the text; a bare `report.pdf` is one only when the whole message is
 * paths, so prose that merely mentions a file does not turn into an attachment card.
 */
export function parseAttachments(text: string): ParsedAttachments {
  const found: Candidate[] = [];
  const quotedRanges: [number, number][] = [];
  const linkRanges: [number, number][] = [];
  const add = (start: number, end: number, path: string, safe: boolean) => {
    path = trimPath(unquote(path.trim()));
    if (!path || isUrl(path) || /[*?]/.test(path) || path.startsWith('-')) return;
    const upload = isUpload(path);
    // Uploads and quoted paths are attachments even in a sentence; other paths wait for the
    // path-only check, so "修改 src/main.ts" stays a message rather than turning into a card.
    const definite = upload || (hasExt(path) && safe);
    if (definite) found.push({ start, end, path, safe: true });
    else if (hasExt(path)) found.push({ start, end, path, safe: false });
  };

  // Upload links written by the composer are Markdown; images use a link rather than "![]()" so
  // an agent's "!" shell shortcut is not triggered. Show them as attachment cards.
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const path = trimPath(unquote((m[2] ?? m[3] ?? '').trim()));
    if (!isUpload(path)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    linkRanges.push([start, end]);
    add(start, end, path, true);
  }

  for (const m of text.matchAll(QUOTED)) {
    quotedRanges.push([m.index!, m.index! + m[0].length]);
    if (linkRanges.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    const before = text.slice(0, m.index!);
    // an HTML attribute or a value in markup is not an attachment of the message
    if (/=\s*$/.test(before) || before.lastIndexOf('<') > before.lastIndexOf('>')) continue;
    const inner = m[1] ?? m[2] ?? '';
    add(m.index!, m.index! + m[0].length, inner, true);
  }
  for (const m of text.matchAll(UNQUOTED)) {
    const raw = m[2];
    const start = m.index! + m[1].length;
    // spaces inside a quoted path must not make its last part another attachment
    if (quotedRanges.some(([s, e]) => start >= s && start < e) || linkRanges.some(([s, e]) => start >= s && start < e)) continue;
    add(start, start + raw.length, raw, false);
  }
  if (!found.length) return { text, attachments: [] };

  // A bare name is safe only if removing every candidate leaves nothing but separators.
  const pathOnly = [...found]
    .sort((a, b) => b.start - a.start)
    .reduce((s, c) => s.slice(0, c.start) + s.slice(c.end), text)
    .replace(QUIET, '') === '';
  const accepted = found.filter((c) => c.safe || pathOnly);
  if (!accepted.length) return { text, attachments: [] };

  const byPath = new Map<string, Attachment>();
  for (const c of accepted.sort((a, b) => a.start - b.start)) if (!byPath.has(c.path)) byPath.set(c.path, attachment(c.path));
  const rest = accepted
    .sort((a, b) => b.start - a.start)
    .reduce((s, c) => s.slice(0, c.start) + s.slice(c.end), text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: rest, attachments: [...byPath.values()] };
}

export function attachmentHint(a: Attachment): string {
  const ext = a.ext ? a.ext.toUpperCase() : '文件';
  if (a.kind === 'pdf') return `${ext} · 在新页面打开`;
  if (a.kind === 'archive') return `${ext} 压缩包 · 在新页面打开`;
  if (a.kind === 'document') return `${ext} 文档 · 在新页面打开`;
  if (a.kind === 'slides') return `${ext} 演示文稿 · 在新页面打开`;
  if (a.kind === 'sheet') return `${ext} 表格 · 点击预览`;
  if (a.kind === 'text' || a.kind === 'code') return `${ext} · 点击预览`;
  return `${ext} · 点击打开`;
}
