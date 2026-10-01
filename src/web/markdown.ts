import { Marked, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeHref = (href: string) => (/^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href : '#');

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
    image({ href, text }: Tokens.Image) {
      // don't let a transcript pull remote images over a slow link
      return `<a href="${esc(safeHref(href))}" target="_blank" rel="noopener noreferrer">[图片: ${esc(text || href)}]</a>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}
