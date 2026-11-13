// Loaded on demand only (it is big): see mermaid-lazy.ts.
import mermaid from 'mermaid';

let seq = 0;
let theme = '';
// strict: no scripts, no click handlers, HTML labels sanitized; agent output is untrusted
const settings = (t: string, htmlLabels = true) => ({
  startOnLoad: false,
  securityLevel: 'strict' as const,
  theme: t as 'dark' | 'default',
  suppressErrorRendering: true,
  htmlLabels,
  flowchart: { htmlLabels },
});

/** Semicolons in the text part of lines ("A->>B: x; y", "Note over A: x; y") escaped as #59;. */
function forgiving(src: string): string {
  return src
    .split('\n')
    .map((l) => {
      const i = l.indexOf(':');
      return i > 0 && l.includes(';', i) ? l.slice(0, i + 1) + l.slice(i + 1).replace(/;/g, '#59;') : l;
    })
    .join('\n');
}

/** Replace a `.mermaid-block` (source in data-src) with the rendered diagram. */
export async function render(block: HTMLElement) {
  const root = document.documentElement.dataset.theme;
  const t = root === 'dark' || (!root && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'default';
  if (t !== theme) {
    mermaid.initialize(settings(t));
    theme = t;
  }
  const src = block.dataset.src || '';
  try {
    const id = `tw-mmd-${++seq}`;
    // a syntax error must not leave mermaid's own error graphic in the page
    const draw = (code: string, n: string) => mermaid.render(n, code).finally(() => document.getElementById('d' + n)?.remove());
    // agents often write ";" inside message text, which mermaid takes as the end of a statement:
    // retry with it escaped (#59; shows as ";")
    let used = src;
    const { svg } = await draw(src, id).catch((e) => {
      const fixed = forgiving(src);
      if (fixed === src) throw e;
      used = fixed;
      return draw(fixed, `${id}b`);
    });
    const view = document.createElement('div');
    view.className = 'mermaid-view';
    view.innerHTML = svg;
    const code = document.createElement('details');
    code.innerHTML = '<summary>源码</summary>';
    const pre = document.createElement('pre');
    pre.textContent = src;
    code.append(pre);
    const save = document.createElement('button');
    save.className = 'link mermaid-save';
    save.textContent = '下载图片';
    save.addEventListener('click', () => {
      const svgEl = view.querySelector('svg');
      if (!svgEl) return;
      save.disabled = true;
      const bg = getComputedStyle(view).getPropertyValue('--panel').trim() || '#fff';
      // Safari won't export a picture with HTML inside (labels): draw it again with plain SVG text
      toPng(svgEl, bg)
        .catch(async () => {
          mermaid.initialize(settings(theme, false));
          try {
            const n = `tw-mmd-${++seq}`;
            const plain = await mermaid.render(n, used).finally(() => document.getElementById('d' + n)?.remove());
            const box = document.createElement('div');
            box.innerHTML = plain.svg;
            return await toPng(box.querySelector('svg')!, bg);
          } finally {
            mermaid.initialize(settings(theme));
          }
        })
        .then((png) => savePng(png, `diagram-${stamp()}.png`))
        .then(
          () => (save.textContent = '已下载'),
          () => (save.textContent = '下载失败'),
        )
        .finally(() => {
          save.disabled = false;
          setTimeout(() => (save.textContent = '下载图片'), 2000);
        });
    });
    const bar = document.createElement('div');
    bar.className = 'mermaid-bar';
    bar.append(code, save);
    block.replaceChildren(view, bar);
  } catch (e: any) {
    const note = document.createElement('p');
    note.className = 'mermaid-err';
    note.textContent = `图表有语法错误，显示源码：${String(e?.message || e).split('\n')[0]}`;
    block.querySelector('button')?.remove();
    block.append(note);
  }
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** The diagram as a PNG at 3x (sharp on phones and in documents), on the chat's background. */
async function toPng(svgEl: SVGSVGElement, background: string): Promise<Blob> {
  const box = svgEl.viewBox.baseVal;
  const w = box?.width || svgEl.getBoundingClientRect().width;
  const h = box?.height || svgEl.getBoundingClientRect().height;
  const copy = svgEl.cloneNode(true) as SVGSVGElement;
  // its own size, not the page's ("100%" / max-width would be resolved against nothing)
  copy.setAttribute('width', String(w));
  copy.setAttribute('height', String(h));
  copy.removeAttribute('style');
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(3, 8000 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
}

function savePng(png: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(png);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
