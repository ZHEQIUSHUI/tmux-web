// Loaded on demand only (it is big): see mermaid-lazy.ts.
import mermaid from 'mermaid';

let seq = 0;
let theme = '';

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
    // strict: no scripts, no click handlers, HTML labels sanitized; agent output is untrusted
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: t,
      suppressErrorRendering: true,
    });
    theme = t;
  }
  const src = block.dataset.src || '';
  try {
    const id = `tw-mmd-${++seq}`;
    // a syntax error must not leave mermaid's own error graphic in the page
    const draw = (code: string, n: string) => mermaid.render(n, code).finally(() => document.getElementById('d' + n)?.remove());
    // agents often write ";" inside message text, which mermaid takes as the end of a statement:
    // retry with it escaped (#59; shows as ";")
    const { svg } = await draw(src, id).catch((e) => {
      const fixed = forgiving(src);
      if (fixed === src) throw e;
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
    block.replaceChildren(view, code);
  } catch (e: any) {
    const note = document.createElement('p');
    note.className = 'mermaid-err';
    note.textContent = `图表有语法错误，显示源码：${String(e?.message || e).split('\n')[0]}`;
    block.querySelector('button')?.remove();
    block.append(note);
  }
}
