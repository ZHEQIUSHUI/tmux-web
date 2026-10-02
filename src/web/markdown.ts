import { Marked, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeHref = (href: string) => (/^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href : '#');

/** Where the images of one chat item come from: its session and log line. */
export interface ImageCtx {
  sid: number;
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
  return out.join('/');
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
  if (m) return `/_tw/api/sessions/${c.sid}/image?off=${c.off}&n=${m[1]}`;
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
  return IMAGE_EXT.test(path) ? `/_tw/api/sessions/${c.sid}/file-image?path=${encodeURIComponent(path)}` : null;
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
      if (lang?.trim().toLowerCase() !== 'mermaid') return false;
      return `<div class="mermaid-block" data-src="${esc(text)}"><pre><code>${esc(text)}</code></pre><button class="link" type="button">显示图表</button></div>`;
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
