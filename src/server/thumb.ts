// Smaller versions of big images for the page: the link to the browser is the slow one, so a
// 5 MB photo goes out as a few hundred KB of WebP sized for the screen. The original stays one tap
// away. sharp is loaded on first use; without it images are simply sent as they are.

type Sharp = typeof import('sharp').default;
let loading: Promise<Sharp | null> | null = null;
const loadSharp = () => (loading ??= import('sharp').then((m) => (m.default ?? m) as unknown as Sharp, () => null));

/** Formats worth shrinking (no SVG: already small; no GIF: may be animated). */
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/avif', 'image/tiff']);
/** Below this, and not larger than asked for, an image is sent as is. */
const MIN_BYTES = 200 * 1024;

/** Recently made versions, by source + width (least recently used dropped beyond the budget). */
const cache = new Map<string, Buffer>();
const CACHE_BUDGET = 64 * 1024 * 1024;
let cached = 0;

/** A width the page may ask for: clamped, in steps (so few versions get made and cached). */
export function thumbWidth(w: string | null): number {
  const n = Number(w);
  if (!n) return 0;
  return Math.min(4096, Math.max(256, Math.ceil(n / 256) * 256));
}

/** A WebP at most `width` wide/high, or null when the original is already fine (or can't be read). */
export async function shrink(key: string, body: Buffer, mime: string, width: number): Promise<Buffer | null> {
  if (!width || !RASTER.has(mime)) return null;
  const k = `${key}|${width}`;
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const img = sharp(body, { failOn: 'none', limitInputPixels: 268_402_689 }).rotate(); // camera orientation
    const meta = await img.metadata();
    const big = Math.max(meta.width ?? 0, meta.height ?? 0) > width;
    if (body.length < MIN_BYTES && !big) return null;
    const out = await img.resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    if (out.length > body.length * 0.85) return null; // not worth it
    cache.set(k, out);
    cached += out.length;
    for (const [old, buf] of cache) {
      if (cached <= CACHE_BUDGET) break;
      cache.delete(old);
      cached -= buf.length;
    }
    return out;
  } catch {
    return null;
  }
}
