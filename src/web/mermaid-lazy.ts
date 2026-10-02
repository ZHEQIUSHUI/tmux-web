import { store } from './lib';

// Mermaid is several hundred KB: it is only fetched for a chat that has a diagram, and the first
// time only when asked. After that this browser renders diagrams automatically (it's cached then).
let mod: Promise<typeof import('./mermaid')> | null = null;

export function hydrateMermaid(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-done])');
  for (const b of blocks) {
    const go = () => {
      store.set('tw:mermaid', 'auto');
      b.dataset.done = '1';
      b.classList.add('loading');
      (mod ??= import('./mermaid'))
        .then((m) => m.render(b))
        .catch(() => {
          mod = null;
          delete b.dataset.done;
          const btn = b.querySelector('button');
          if (btn) {
            btn.textContent = '加载失败，点此重试';
            btn.addEventListener('click', go, { once: true });
          }
        })
        .finally(() => b.classList.remove('loading'));
    };
    if (store.get('tw:mermaid') === 'auto') go();
    else b.querySelector('button')?.addEventListener('click', go, { once: true });
  }
}
