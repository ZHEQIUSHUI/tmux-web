import { useEffect, useState } from 'preact/hooks';
import { store } from './lib';

// Split views (desktop): up to 2×2 sessions side by side. A view is only a layout kept in this
// browser — which sessions, where, how big — never a session of its own. It shows in 最近 while one
// of its sessions is recent, and is cleaned up after that.

/** Rows of session ids, top to bottom; at most 2 rows of at most 2. */
export type Grid = number[][];
export interface MultiView {
  id: string;
  grid: Grid;
  /** height share of each row, and width share of each pane per row (fractions) */
  rowSizes?: number[];
  colSizes?: number[][];
}
export type Dir = 'left' | 'right' | 'top' | 'bottom';

const KEY = 'tw:multi';
const read = (): MultiView[] => {
  try {
    const v = JSON.parse(store.get(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && Array.isArray(x.grid)) : [];
  } catch {
    return [];
  }
};
function write(list: MultiView[]) {
  store.set(KEY, list.length ? JSON.stringify(list) : null);
  dispatchEvent(new Event('tw:multi'));
}

export const getView = (id: string) => read().find((v) => v.id === id) ?? null;
export function saveView(v: MultiView) {
  const list = read().filter((x) => x.id !== v.id);
  write([...list, v]);
}
export function removeView(id: string) {
  write(read().filter((x) => x.id !== id));
}
export const newViewId = () => Math.random().toString(36).slice(2, 8);
export const idsOf = (g: Grid) => g.flat();

/** Every saved view, kept in sync across the page. */
export function useViews(): MultiView[] {
  const [list, setList] = useState(read);
  useEffect(() => {
    const on = () => setList(read());
    addEventListener('tw:multi', on);
    return () => removeEventListener('tw:multi', on);
  }, []);
  return list;
}

/** The split view in the address: #/m/<id>. */
export function useHashView(): [string | null, (id: string | null) => void] {
  const parse = () => /^#\/m\/([\w-]+)/.exec(location.hash)?.[1] ?? null;
  const [id, setId] = useState(parse);
  useEffect(() => {
    const on = () => setId(parse());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [id, (v) => (location.hash = v ? `#/m/${v}` : '')];
}

/**
 * The grid with session `sid` added next to the pane of `target` in direction `dir`, or null when
 * there is no room (a row holds 2, there are at most 2 rows) or it is already shown.
 */
export function place(grid: Grid, target: number, dir: Dir, sid: number): Grid | null {
  if (idsOf(grid).includes(sid)) return null;
  const r = grid.findIndex((row) => row.includes(target));
  if (r < 0) return null;
  const g = grid.map((row) => [...row]);
  if (dir === 'left' || dir === 'right') {
    if (g[r].length >= 2) return null;
    const c = g[r].indexOf(target);
    g[r].splice(dir === 'left' ? c : c + 1, 0, sid);
    return g;
  }
  if (g.length >= 2) return null;
  g.splice(dir === 'top' ? r : r + 1, 0, [sid]);
  return g;
}

/** The view without session `sid` (sizes reset where the shape changed). */
export function without(v: MultiView, sid: number): MultiView {
  const grid = v.grid.map((row) => row.filter((x) => x !== sid)).filter((row) => row.length);
  const same = grid.length === v.grid.length;
  return {
    ...v,
    grid,
    rowSizes: same ? v.rowSizes : undefined,
    colSizes: same ? v.colSizes?.map((c, i) => (grid[i].length === v.grid[i].length ? c : (undefined as never))) : undefined,
  };
}

/** Equal shares unless sized (and the sizes still fit the shape). */
export const shares = (n: number, sized?: number[]) => (sized && sized.length === n ? sized : Array(n).fill(1 / n));
