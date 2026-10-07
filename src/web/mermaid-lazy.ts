// Mermaid is a few hundred KB: it is fetched only when a diagram scrolls into view (so chats
// without diagrams never load it), then cached by the browser like the rest of the page.
let mod: Promise<typeof import('./mermaid')> | null = null;

const seen =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            seen!.unobserve(e.target);
            render(e.target as HTMLElement);
          }
        },
        { rootMargin: '300px 0px' },
      );

function render(b: HTMLElement) {
  if (b.dataset.done) return;
  b.dataset.done = '1';
  b.classList.add('loading');
  const btn = b.querySelector('button');
  if (btn) {
    btn.textContent = '图表加载中…';
    btn.disabled = true;
  }
  (mod ??= import('./mermaid'))
    .then((m) => m.render(b))
    .catch(() => {
      mod = null;
      delete b.dataset.done;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '图表加载失败，点此重试';
        btn.addEventListener('click', () => render(b), { once: true });
      }
    })
    .finally(() => b.classList.remove('loading'));
}

export function hydrateMermaid(root: HTMLElement) {
  for (const b of root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-done])')) {
    // the button still works where the observer can't (or before it fires)
    b.querySelector('button')?.addEventListener('click', () => render(b), { once: true });
    if (seen) seen.observe(b);
    else render(b);
  }
}
