import { useEffect, useRef, useState } from 'preact/hooks';
import { shown } from './markdown';

interface Pic {
  url: string;
  alt: string;
}
interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(1, s));

/**
 * Images in the chat and the files tab open here, over the page: zoom (wheel, pinch, double tap),
 * drag when zoomed, the other images of the same conversation with ← → or a swipe. Esc, a tap
 * beside the image or the back button (phones, the Android app) close it. Ctrl/⌘-click still
 * opens the image in a tab of its own.
 */
export function Lightbox() {
  const [pics, setPics] = useState<Pic[] | null>(null);
  const [at, setAt] = useState(0);
  const [view, setView] = useState<View>(FIT);
  const [src, setSrc] = useState('');
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const close = () => {
    if (history.state?.twLightbox) history.back();
    else setPics(null);
  };

  // open: clicks on our image links, anywhere on the page
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a.md-img') as HTMLAnchorElement | null;
      if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const root = a.closest('.chat, .fv-body') ?? document;
      const links = [...root.querySelectorAll<HTMLAnchorElement>('a.md-img')];
      setPics(links.map((l) => ({ url: l.getAttribute('href')!, alt: l.querySelector('img')?.alt ?? '' })));
      setAt(Math.max(0, links.indexOf(a)));
      history.pushState({ ...history.state, twLightbox: true }, '');
    };
    const onPop = () => setPics(null);
    document.addEventListener('click', onClick, true);
    addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('click', onClick, true);
      removeEventListener('popstate', onPop);
    };
  }, []);

  const pic = pics?.[at];
  // the screen-sized version (already loaded in the chat) at once, the original once it's here
  useEffect(() => {
    if (!pic) return;
    setView(FIT);
    const small = shown(pic.url);
    setSrc(small);
    if (small === pic.url) return;
    setBusy(true);
    const full = new Image();
    full.onload = () => {
      setSrc(pic.url);
      setBusy(false);
    };
    full.onerror = () => setBusy(false);
    full.src = pic.url;
    return () => {
      full.onload = full.onerror = null;
    };
  }, [pic?.url]);

  const go = (d: number) => pics && pics.length > 1 && setAt((i) => (i + d + pics.length) % pics.length);

  useEffect(() => {
    if (!pics) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
    };
  }, [pics]);

  // zoom by `k` keeping the point (cx, cy) (relative to the stage's center) where it is
  const zoomAt = (v: View, s: number, cx: number, cy: number): View => {
    s = clamp(s);
    if (s === 1) return FIT;
    const r = s / v.s;
    return { s, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
  };
  const center = (e: { clientX: number; clientY: number }) => {
    const b = stage.current!.getBoundingClientRect();
    return [e.clientX - b.left - b.width / 2, e.clientY - b.top - b.height / 2] as const;
  };

  // pointers: drag (zoomed) or swipe (not), pinch with two, double tap to zoom
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: View; x: number; y: number; dist?: number; mx?: number; my?: number; moved: boolean; t: number } | null>(null);
  const lastTap = useRef(0);
  const [swipe, setSwipe] = useState(0);

  const onDown = (e: PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...ptrs.current.values()];
    if (p.length === 2) {
      const [cx, cy] = center({ clientX: (p[0].x + p[1].x) / 2, clientY: (p[0].y + p[1].y) / 2 });
      gesture.current = { start: viewRef.current, x: 0, y: 0, dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: cx, my: cy, moved: true, t: 0 };
      setSwipe(0);
    } else if (p.length === 1) {
      gesture.current = { start: viewRef.current, x: e.clientX, y: e.clientY, moved: false, t: Date.now() };
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const p = [...ptrs.current.values()];
    if (p.length >= 2 && g.dist) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      setView(zoomAt(g.start, (g.start.s * d) / g.dist, g.mx!, g.my!));
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (!g.moved) return;
    if (g.start.s > 1) setView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy });
    else if (!g.dist) setSwipe(dx);
  };
  const onUp = (e: PointerEvent) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (ptrs.current.size > 0) {
      // one finger of a pinch lifted: carry on dragging with the other
      const [rest] = ptrs.current.values();
      gesture.current = { start: viewRef.current, x: rest.x, y: rest.y, moved: true, t: 0 };
      return;
    }
    gesture.current = null;
    if (!g) return;
    if (swipe) {
      if (Math.abs(swipe) > 60) go(swipe < 0 ? 1 : -1);
      setSwipe(0);
      return;
    }
    if (g.moved) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // double tap: zoom in there, or back to fit
      lastTap.current = 0;
      const [cx, cy] = center(e);
      setView((v) => (v.s > 1 ? FIT : zoomAt(v, 2.5, cx, cy)));
      return;
    }
    lastTap.current = now;
    // a tap beside the image closes (after the double-tap window, so a double tap doesn't)
    if (!(e.target as Element).closest('img') && viewRef.current.s === 1) {
      const t = now;
      setTimeout(() => lastTap.current === t && close(), 300);
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [cx, cy] = center(e);
    setView((v) => zoomAt(v, v.s * Math.exp(-e.deltaY * 0.0025), cx, cy));
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [!!pics]);

  if (!pics || !pic) return null;
  const name = pic.alt || decodeURIComponent(pic.url.split(/[/=]/).pop() || '图片');
  return (
    <div class="lb" role="dialog" aria-label="图片">
      <div class="lb-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span class="lb-name" title={name}>
          {pics.length > 1 && <b>{at + 1} / {pics.length}</b>}
          {name}
        </span>
        {busy && <span class="spinner lb-spin" title="正在加载原图" />}
        {view.s > 1 && (
          <button class="lb-btn" onClick={() => setView(FIT)} title="适合屏幕">
            {Math.round(view.s * 100)}%
          </button>
        )}
        <a class="lb-btn" href={pic.url} target="_blank" rel="noopener noreferrer" title="在新标签页打开原图">
          ↗
        </a>
        <a class="lb-btn" href={pic.url} download={pic.alt || 'image'} title="下载">
          ⤓
        </a>
        <button class="lb-btn" onClick={close} title="关闭（Esc）" aria-label="关闭">
          ✕
        </button>
      </div>
      <div class="lb-stage" ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <img
          src={src}
          alt={pic.alt}
          draggable={false}
          class={gesture.current ? '' : 'lb-ease'}
          style={{ transform: `translate(${view.x + swipe}px, ${view.y}px) scale(${view.s})`, cursor: view.s > 1 ? 'grab' : 'zoom-in' }}
        />
      </div>
      {pics.length > 1 && (
        <>
          <button class="lb-nav prev" onClick={() => go(-1)} aria-label="上一张">
            ‹
          </button>
          <button class="lb-nav next" onClick={() => go(1)} aria-label="下一张">
            ›
          </button>
        </>
      )}
    </div>
  );
}
