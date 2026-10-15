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
/** how long a page turn / snap back takes */
const TURN_MS = 280;
/** dark space between neighbouring images while they slide */
const GAP = 24;

/**
 * Images in the chat and the files tab open here, over the page: zoom (wheel, pinch, double tap),
 * drag when zoomed, the other images of the same conversation side by side (swipe, ← →), drag
 * down to close. Esc, a tap beside the image or the back button (phones, the Android app) close it
 * too. Ctrl/⌘-click still opens the image in a tab of its own.
 */
export function Lightbox() {
  const [pics, setPics] = useState<Pic[] | null>(null);
  const [at, setAt] = useState(0);
  const [view, setView] = useState<View>(FIT);
  /** originals loaded so far (until then the screen-sized version, already in the chat, shows) */
  const [full, setFull] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** the strip of images: dx while swiping / turning, dy while dragging down to close */
  const [slide, setSlide] = useState({ dx: 0, dy: 0, ease: false });
  const [closing, setClosing] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const turning = useRef(false);
  /** the turn under way (-1 / 1), so the counter shows where it's going at once */
  const [toward, setToward] = useState(0);

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
      setSlide({ dx: 0, dy: 0, ease: false });
      setClosing(false);
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
  // the original of the one in front
  useEffect(() => {
    if (!pic) return;
    setView(FIT);
    if (full.has(pic.url) || shown(pic.url) === pic.url) return setBusy(false);
    setBusy(true);
    const img = new Image();
    img.onload = () => {
      setFull((f) => new Set(f).add(pic.url));
      setBusy(false);
    };
    img.onerror = () => setBusy(false);
    img.src = pic.url;
    return () => {
      img.onload = img.onerror = null;
    };
  }, [pic?.url]);
  const srcOf = (p: Pic) => (full.has(p.url) ? p.url : shown(p.url));

  const width = () => stage.current?.clientWidth || innerWidth;
  /** turn to the next (1) / previous (-1) image: the strip slides over, then the index moves on */
  const turn = (d: number) => {
    if (!pics || pics.length < 2 || turning.current) return;
    turning.current = true;
    setToward(d);
    setView(FIT);
    setSlide({ dx: -d * (width() + GAP), dy: 0, ease: true });
    setTimeout(() => {
      // the neighbour is now in the middle: swap it in without anything moving
      setAt((i) => (i + d + pics.length) % pics.length);
      setSlide({ dx: 0, dy: 0, ease: false });
      setToward(0);
      turning.current = false;
    }, TURN_MS);
  };
  const snapBack = () => setSlide({ dx: 0, dy: 0, ease: true });

  useEffect(() => {
    if (!pics) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') turn(-1);
      else if (e.key === 'ArrowRight') turn(1);
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

  // zoom to s keeping the point (cx, cy) (relative to the stage's center) where it is
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

  // pointers: pan (zoomed), swipe sideways / drag down (not), pinch with two, double tap to zoom
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  type Gesture = {
    start: View;
    x: number;
    y: number;
    dist?: number;
    mx?: number;
    my?: number;
    /** decided on the first real move: 'pan' (zoomed), 'x' (swipe), 'y' (drag down) */
    kind?: 'pan' | 'x' | 'y' | 'pinch';
    /** recent positions, for the speed at release */
    track: { t: number; x: number; y: number }[];
  };
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastTap = useRef(0);

  const onDown = (e: PointerEvent) => {
    if (turning.current) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...ptrs.current.values()];
    if (p.length === 2) {
      const [cx, cy] = center({ clientX: (p[0].x + p[1].x) / 2, clientY: (p[0].y + p[1].y) / 2 });
      gesture.current = { start: viewRef.current, x: 0, y: 0, dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: cx, my: cy, kind: 'pinch', track: [] };
      if (slide.dx || slide.dy) snapBack();
    } else if (p.length === 1) {
      gesture.current = { start: viewRef.current, x: e.clientX, y: e.clientY, track: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    }
    setDragging(true);
  };
  const onMove = (e: PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const p = [...ptrs.current.values()];
    if (g.kind === 'pinch') {
      if (p.length < 2 || !g.dist) return;
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      setView(zoomAt(g.start, (g.start.s * d) / g.dist, g.mx!, g.my!));
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.track.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (g.track.length > 6) g.track.shift();
    if (!g.kind) {
      if (Math.hypot(dx, dy) < 8) return;
      // the direction is fixed once the finger really moves: no diagonal drifting
      g.kind = g.start.s > 1 ? 'pan' : Math.abs(dx) >= Math.abs(dy) ? 'x' : dy > 0 ? 'y' : 'pan';
    }
    if (g.kind === 'pan') {
      if (g.start.s > 1) setView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy });
    } else if (g.kind === 'x') {
      // past the first / last one (or a single image) it gives, but reluctantly
      const edge = !pics || pics.length < 2;
      setSlide({ dx: edge ? dx * 0.25 : dx, dy: 0, ease: false });
    } else if (g.kind === 'y') {
      setSlide({ dx: 0, dy: Math.max(0, dy), ease: false });
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (ptrs.current.size > 0) {
      // one finger of a pinch lifted: carry on panning with the other
      const [rest] = ptrs.current.values();
      gesture.current = { start: viewRef.current, x: rest.x, y: rest.y, kind: viewRef.current.s > 1 ? 'pan' : 'pinch', track: [] };
      return;
    }
    gesture.current = null;
    setDragging(false);
    if (!g) return;
    // speed over the last moments (px/ms)
    const a = g.track[0];
    const b = g.track[g.track.length - 1];
    const dt = Math.max(1, (b?.t ?? 0) - (a?.t ?? 0));
    const vx = a && b ? (b.x - a.x) / dt : 0;
    const vy = a && b ? (b.y - a.y) / dt : 0;
    if (g.kind === 'x') {
      const dx = e.clientX - g.x;
      const far = Math.abs(dx) > width() * 0.22 || Math.abs(vx) > 0.45;
      // a flick counts in the direction it went, even if short
      const d = far ? (Math.abs(vx) > 0.45 ? -Math.sign(vx) : -Math.sign(dx)) : 0;
      if (d && pics && pics.length > 1) turn(d);
      else snapBack();
      return;
    }
    if (g.kind === 'y') {
      const dy = e.clientY - g.y;
      if (dy > 140 || vy > 0.6) {
        setClosing(true);
        setSlide({ dx: 0, dy: dy + 200, ease: true });
        setTimeout(close, 180);
      } else snapBack();
      return;
    }
    if (g.kind) return;
    // a tap
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
  const n = pics.length;
  // the one in front and its neighbours, side by side
  // (with two, the other one is on the side it's coming from)
  const slides =
    n > 2 ? [-1, 0, 1].map((k) => ({ k, i: (at + k + n) % n })) : n === 2 ? [{ k: 0, i: at }, { k: slide.dx > 0 ? -1 : 1, i: 1 - at }] : [{ k: 0, i: at }];
  const fade = closing ? 0 : Math.max(0.2, 1 - slide.dy / 700);
  const name = pic.alt || decodeURIComponent(pic.url.split(/[/=]/).pop() || '图片');
  const ease = `${TURN_MS}ms cubic-bezier(0.22, 0.8, 0.24, 1)`;
  return (
    <div class="lb" role="dialog" aria-label="图片" style={{ background: `rgb(14 14 14 / ${fade})`, transition: slide.ease ? `background ${ease}` : 'none' }}>
      <div class="lb-bar" style={{ opacity: closing ? 0 : Math.max(0, 1 - slide.dy / 120), transition: slide.ease ? 'opacity 0.2s' : 'none' }} onPointerDown={(e) => e.stopPropagation()}>
        <span class="lb-name" title={name}>
          {n > 1 && (
            <b>
              {((at + toward + n) % n) + 1} / {n}
            </b>
          )}
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
        <div
          class="lb-strip"
          style={{
            transform: `translate3d(${slide.dx}px, ${slide.dy}px, 0) scale(${1 - Math.min(slide.dy, 400) / 2000})`,
            transition: slide.ease ? `transform ${ease}` : 'none',
          }}
        >
          {slides.map(({ k, i }) => (
            // keyed by image: after a turn the neighbour's element just becomes the middle one
            <div key={i} class="lb-slide" style={{ left: `calc(${k} * (100% + ${GAP}px))` }}>
              <img
                src={srcOf(pics[i])}
                alt={pics[i].alt}
                draggable={false}
                style={
                  k === 0
                    ? {
                        transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                        transition: dragging ? 'none' : 'transform 0.2s ease-out',
                        cursor: view.s > 1 ? 'grab' : 'zoom-in',
                      }
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      </div>
      {n > 1 && (
        <>
          <button class="lb-nav prev" onClick={() => turn(-1)} aria-label="上一张">
            ‹
          </button>
          <button class="lb-nav next" onClick={() => turn(1)} aria-label="下一张">
            ›
          </button>
        </>
      )}
    </div>
  );
}
