import { Marked, type Tokens } from 'marked';
import { copyText } from './lib';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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

export const imageHtml = (url: string, alt: string) =>
  `<a class="md-img" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async"></a>`;

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
        return `<div class="code-wrap"><button type="button" class="copy-btn code-copy" data-copy-code>复制</button><pre><code${kind ? ` class="language-${esc(kind)}"` : ''}>${esc(text.replace(/\n$/, ''))}</code></pre></div>`;
      return `<div class="mermaid-block" data-src="${esc(text)}"><pre><code>${esc(text)}</code></pre><button class="link" type="button">显示图表</button></div>`;
    },
    // a quote is often something to pass on ("可以直接转给…"): copy it as Markdown, without the "> "
    blockquote({ tokens, raw }: Tokens.Blockquote) {
      const source = raw
        .replace(/\n+$/, '')
        .split('\n')
        .map((l) => l.replace(/^ {0,3}> ?/, ''))
        .join('\n');
      return `<div class="quote-wrap"><button type="button" class="copy-btn quote-copy" data-copy-text="${esc(source)}">复制</button><blockquote>${this.parser.parse(tokens)}</blockquote></div>`;
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
  const text = btn.dataset.copyText ?? btn.parentElement?.querySelector('pre')?.textContent ?? '';
  void copyText(text).then((ok) => {
    btn.textContent = ok ? '已复制' : '复制失败';
    btn.classList.toggle('ok', ok);
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('ok');
    }, 1500);
  });
});
