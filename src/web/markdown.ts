import { Marked, type Tokens } from 'marked';
import { copyText } from './lib';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// GitHub-style: a small icon, a check once copied
const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

const safeHref = (href: string) => (/^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href : '#');

/** Where the images of one chat item come from: its session and log line. */
export interface ImageCtx {
  /** route prefix: /_tw/api/sessions/<id> (or /_tw/api/hosts/<id> for files) */
  api: string;
  off: string;
  /** directory that relative image paths start from (a Markdown file in the files tab) */
  base?: string;
}

/** Join a relative path onto a directory, resolving "." and "..". */
export function joinPath(base: string, rel: string): string {
  if (!base || rel.startsWith('/') || rel.startsWith('~')) return rel;
  const out = base.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return (base.startsWith('/') ? '/' : '') + out.join('/');
}
let ctx: ImageCtx | null = null;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/**
 * URL to show an image reference with, or null to keep it a plain link. Embedded images come from
 * the server as `tw-img:<n>`, files on the host by path; remote images are never fetched on their own.
 */
export function imageUrl(href: string, c: ImageCtx | null = ctx): string | null {
  href = href.trim();
  if (!c) return null;
  const m = /^tw-img:(\d+)$/.exec(href);
  if (m) return `${c.api}/image?off=${c.off}&n=${m[1]}`;
  if (/^data:image\/(png|jpe?g|gif|webp)[;,]/i.test(href)) return href;
  if (/^(\/_tw\/|\/p\/)/.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
  let path = href.replace(/^<|>$/g, '');
  try {
    path = decodeURI(path);
  } catch {
    /* keep as written */
  }
  if (c.base) path = joinPath(c.base, path);
  return IMAGE_EXT.test(path) ? `${c.api}/file-image?path=${encodeURIComponent(path)}` : null;
}

/**
 * What the page shows of an image of ours: a version sized for the screen (the server shrinks big
 * ones, see thumb.ts). Links keep pointing at the original.
 */
export const shown = (url: string, width = 1280) => (/^\/_tw\/api\/.*\/(file-)?image\?/.test(url) ? `${url}&w=${width}` : url);

export const imageHtml = (url: string, alt: string) =>
  `<a class="md-img" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="点开看原图"><img src="${esc(shown(url))}" alt="${esc(alt)}" loading="lazy" decoding="async"></a>`;

const IMAGE_MD = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;
/** Plain-text items (your messages, tool output): pull the image references out to show below. */
export function splitImages(text: string, c: ImageCtx): { text: string; images: { url: string; alt: string }[] } {
  const images: { url: string; alt: string }[] = [];
  const rest = text.replace(IMAGE_MD, (all, alt: string, href: string) => {
    const url = imageUrl(href, c);
    if (!url) return all;
    images.push({ url, alt });
    return '';
  });
  return { text: images.length ? rest.trim() : text, images };
}

// Agent output is untrusted: raw HTML is shown as text and only http(s)/mailto links survive.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      return `<a href="${esc(safeHref(href))}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    code({ text, lang }: Tokens.Code) {
      const kind = lang?.trim().split(/\s/)[0].toLowerCase() ?? '';
      if (kind !== 'mermaid')
        // the button floats in the corner: only the lines beside it make room
        return `<pre class="code-wrap"><button type="button" class="md-copy" data-copy-code title="复制" aria-label="复制">${COPY_ICON}</button><code${kind ? ` class="language-${esc(kind)}"` : ''}>${esc(text.replace(/\n$/, ''))}</code></pre>`;
      return `<div class="mermaid-block" data-src="${esc(text)}"><pre><code>${esc(text)}</code></pre><button class="link" type="button">显示图表</button></div>`;
    },
    // a quote is often something to pass on ("可以直接转给…"): copy it as Markdown, without the "> "
    blockquote({ tokens, raw }: Tokens.Blockquote) {
      const source = raw
        .replace(/\n+$/, '')
        .split('\n')
        .map((l) => l.replace(/^ {0,3}> ?/, ''))
        .join('\n');
      return `<blockquote class="quote-wrap"><button type="button" class="md-copy" data-copy-text="${esc(source)}" title="复制这段" aria-label="复制这段">${COPY_ICON}</button>${this.parser.parse(tokens)}</blockquote>`;
    },
    image({ href, text }: Tokens.Image) {
      const url = imageUrl(href);
      if (url) return imageHtml(url, text);
      // don't let a transcript pull remote images over a slow link
      return `<a href="${esc(safeHref(href))}" target="_blank" rel="noopener noreferrer">[图片: ${esc(text || href)}]</a>`;
    },
  },
});

export function renderMarkdown(src: string, images?: ImageCtx): string {
  ctx = images ?? null;
  try {
    return md.parse(src, { async: false }) as string;
  } finally {
    ctx = null;
  }
}

// code blocks and quotes are plain HTML (the chat caches rendered Markdown): one listener serves every 复制
document.addEventListener('click', (e) => {
  const btn = (e.target as Element | null)?.closest?.<HTMLButtonElement>('[data-copy-code],[data-copy-text]');
  if (!btn) return;
  e.stopPropagation();
  const text = btn.dataset.copyText ?? btn.closest('pre')?.querySelector('code')?.textContent ?? '';
  void copyText(text).then((ok) => {
    btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
    btn.classList.add(ok ? 'ok' : 'fail');
    btn.title = ok ? '已复制' : '复制失败';
    setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.classList.remove('ok', 'fail');
      btn.title = '复制';
    }, 1500);
  });
});
