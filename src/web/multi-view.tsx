import { useEffect, useRef, useState } from 'preact/hooks';
import type { Folder, Me, SessionInfo } from './api';
import { type Dir, type MultiView, place, saveView, shares, without } from './multi';

// The split view on the page: rows of session panes with draggable dividers, and drop zones for
// sessions dragged in from the list.

const DRAG_TYPE = 'text/tw-session';

/** A session from the list is being dragged (the drop zones cover the panes, iframes included). */
export function useSessionDrag(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setOn(true);
    const end = () => setOn(false);
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);
  return on;
}

const DIR_LABEL: Record<Dir, string> = { left: '放到左边', right: '放到右边', top: '放到上面', bottom: '放到下面' };

/** Over a pane while dragging: the half the session would go to lights up. */
export function DropZones({ can, onDrop }: { can: (dir: Dir) => boolean; onDrop: (dir: Dir, sid: number) => void }) {
  const [dir, setDir] = useState<Dir | null>(null);
  const pick = (e: DragEvent): Dir | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    // the nearest edge that has room
    const order = (
      [
        ['left', x],
        ['right', 1 - x],
        ['top', y],
        ['bottom', 1 - y],
      ] as [Dir, number][]
    ).sort((a, b) => a[1] - b[1]);
    return order.find(([d]) => can(d))?.[0] ?? null;
  };
  return (
    <div
      class={`drop-zones ${dir ?? ''}`}
      onDragOver={(e) => {
        const d = pick(e);
        setDir(d);
        if (d) e.preventDefault();
      }}
      onDragLeave={() => setDir(null)}
      onDrop={(e) => {
        e.preventDefault();
        const d = pick(e);
        const sid = Number(e.dataTransfer?.getData(DRAG_TYPE));
        setDir(null);
        if (d && sid) onDrop(d, sid);
      }}
    >
      {dir && <div class={`drop-hint ${dir}`}>{DIR_LABEL[dir]}</div>}
    </div>
  );
}

/** A divider between two panes or rows; reports the new share of the first one while dragged. */
function Splitter({ vertical, onMove, onDone }: { vertical: boolean; onMove: (share: number) => void; onDone: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={el}
      class={`splitter ${vertical ? 'v' : 'h'}`}
      onPointerDown={(e) => {
        const box = el.current!.parentElement!.getBoundingClientRect();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => {
          const share = vertical ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
          onMove(Math.max(0.15, Math.min(0.85, share)));
        };
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          document.body.classList.remove('resizing');
          onDone();
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      }}
    />
  );
}

type PaneProps = { session: SessionInfo; onClose?: () => void };

/**
 * The split view: `renderPane` draws one session (the shell's SessionPane). Dividers resize,
 * dropped sessions join, ✕ on a pane takes it out. `onChange(null)` = back to one pane.
 */
export function MultiPane(props: {
  me: Me;
  view: MultiView;
  sessions: SessionInfo[];
  folders: Folder[];
  renderPane: (p: PaneProps) => any;
  onSingle: (sid: number) => void;
}) {
  const dragging = useSessionDrag();
  const [view, setView] = useState(props.view);
  useEffect(() => setView(props.view), [props.view]);
  const byId = new Map(props.sessions.map((s) => [s.id, s]));
  // sessions that are gone (deleted, no access) drop out of the layout
  const grid = view.grid.map((row) => row.filter((id) => byId.has(id))).filter((row) => row.length);
  const total = grid.flat().length;
  useEffect(() => {
    if (props.sessions.length && total === 1) props.onSingle(grid[0][0]);
  }, [total, props.sessions.length]);
  const rows = shares(grid.length, view.rowSizes);
  const commit = (v: MultiView) => {
    setView(v);
    saveView(v);
  };
  const close = (sid: number) => {
    const v = without(view, sid);
    if (v.grid.flat().length <= 1) return props.onSingle(v.grid.flat()[0]);
    commit(v);
  };
  return (
    <section class="multi">
      {grid.map((row, r) => {
        const cols = shares(row.length, view.colSizes?.[r]);
        return (
          <>
            {r > 0 && (
              <Splitter
                vertical={false}
                onMove={(share) => setView((v) => ({ ...v, rowSizes: [share, 1 - share] }))}
                onDone={() => setView((v) => (saveView(v), v))}
              />
            )}
            <div class="multi-row" key={`r${r}`} style={{ flex: `${rows[r]} 1 0` }}>
              {row.map((id, c) => (
                <>
                  {c > 0 && (
                    <Splitter
                      vertical
                      onMove={(share) =>
                        setView((v) => {
                          const colSizes = grid.map((rw, i) => shares(rw.length, v.colSizes?.[i]));
                          colSizes[r] = [share, 1 - share];
                          return { ...v, colSizes };
                        })
                      }
                      onDone={() => setView((v) => (saveView(v), v))}
                    />
                  )}
                  <div class="multi-cell" key={id} style={{ flex: `${cols[c]} 1 0` }}>
                    {props.renderPane({ session: byId.get(id)!, onClose: () => close(id) })}
                    {dragging && (
                      <DropZones
                        can={(d) => !!place(grid, id, d, -1)}
                        onDrop={(d, sid) => {
                          const g = place(grid, id, d, sid);
                          if (g) commit({ ...view, grid: g, rowSizes: g.length === grid.length ? view.rowSizes : undefined, colSizes: undefined });
                        }}
                      />
                    )}
                  </div>
                </>
              ))}
            </div>
          </>
        );
      })}
    </section>
  );
}
