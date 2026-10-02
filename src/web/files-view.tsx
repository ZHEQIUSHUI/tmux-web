import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type SessionInfo } from './api';
import { ago, copyText, store } from './lib';
import { joinPath, renderMarkdown } from './markdown';
import { Icon, Modal } from './ui';

// Files tab: browse the session's working directory, read files, see what changed in git, and
// hand paths to the agent. Read-only on purpose: changes go through the agent.

interface Entry {
  name: string;
  type: 'd' | 'f' | 'o';
  link: boolean;
  size: number;
  mtime: number;
}
interface Listing {
  dir: string;
  entries: Entry[];
  truncated: boolean;
}
interface Change {
  path: string;
  status: string;
  from?: string;
  added?: number;
  removed?: number;
}
interface Changes {
  root: string;
  cwd: string;
  files: Change[];
}
/** An open file, or one changed file's diff. Paths are relative to the working directory. */
type Doc = { kind: 'file'; path: string } | { kind: 'diff'; path: string; repoPath: string; status: string };

/** Where you were in each session's files tab, kept while the page is open. */
const places = new Map<number, { mode: 'files' | 'changes'; dir: string; doc: Doc | null }>();

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const CHUNK = 64 * 1024;

export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
const parent = (p: string) => p.split('/').slice(0, -1).join('/');
const baseName = (p: string) => p.split('/').pop() || p;
const q = (p: string) => encodeURIComponent(p);

export function FilesView({ session, onInsert }: { session: SessionInfo; onInsert: (text: string) => void }) {
  const id = session.id;
  const saved = places.get(id);
  const [mode, setMode] = useState<'files' | 'changes'>(saved?.mode ?? 'files');
  const [dir, setDir] = useState(saved?.dir ?? '');
  const [doc, setDoc] = useState<Doc | null>(saved?.doc ?? null);
  const [root, setRoot] = useState(''); // absolute working directory, for full paths
  const [actions, setActions] = useState<{ path: string; dir: boolean } | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => void places.set(id, { mode, dir, doc }), [id, mode, dir, doc]);
  const top = () => document.querySelector('.fv-body')?.scrollTo(0, 0);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? '' : x)), 1600);
  };
  const full = (p: string) => (p.startsWith('/') || p.startsWith('~') ? p : root ? `${root}/${p}`.replace(/\/$/, '') : p);
  // Claude Code reads "@path" as a file reference
  const mention = (p: string) => (session.agent === 'claude' ? `@${p || '.'}` : p || '.');
  const act = {
    insert: (p: string) => onInsert(mention(p)),
    copy: async (text: string) => flash((await copyText(text)) ? '已复制' : '复制失败，请长按手动复制'),
    download: (p: string) => {
      const a = document.createElement('a');
      a.href = `/_tw/api/sessions/${id}/files/download?path=${q(p)}`;
      a.download = baseName(p);
      a.click();
    },
  };
  const openDir = (p: string) => (setDir(p), setDoc(null), top());
  const openDoc = (d: Doc) => (setDoc(d), top());

  return (
    <div class="files">
      <div class="fv-bar">
        <div class="tabs fv-mode">
          <button class={mode === 'files' ? 'on' : ''} onClick={() => (setMode('files'), setDoc(null))}>
            文件
          </button>
          <button class={mode === 'changes' ? 'on' : ''} onClick={() => (setMode('changes'), setDoc(null))}>
            改动
          </button>
        </div>
        {doc && (
          <button class="ghost small" onClick={() => (setDoc(null), top())}>
            ‹ 返回
          </button>
        )}
      </div>
      <div class="fv-body">
        {doc?.kind === 'file' ? (
          <FileViewer sid={id} path={doc.path} onActions={() => setActions({ path: doc.path, dir: false })} />
        ) : doc?.kind === 'diff' ? (
          <DiffViewer sid={id} view={doc} onActions={() => setActions({ path: doc.path, dir: false })} />
        ) : mode === 'changes' ? (
          <ChangeList sid={id} onRoot={setRoot} onOpen={openDoc} />
        ) : (
          <DirList sid={id} path={dir} onRoot={setRoot} onDir={openDir} onFile={(p) => openDoc({ kind: 'file', path: p })} onActions={(path, d) => setActions({ path, dir: d })} />
        )}
      </div>
      {actions && (
        <Modal title={actions.path || '工作目录'} onClose={() => setActions(null)}>
          <div class="sheet-list">
            {session.access === 'control' && session.agent !== 'bash' && (
              <button onClick={() => (setActions(null), act.insert(actions.path))}>
                插入到输入框<span class="check dim fv-ell">{mention(actions.path)}</span>
              </button>
            )}
            <button onClick={() => (setActions(null), act.copy(actions.path || '.'))}>复制相对路径</button>
            <button onClick={() => (setActions(null), act.copy(full(actions.path)))}>
              复制完整路径<span class="check dim fv-ell">{full(actions.path)}</span>
            </button>
            {!actions.dir && <button onClick={() => (setActions(null), act.download(actions.path))}>下载</button>}
          </div>
        </Modal>
      )}
      {toast && <div class="fv-toast">{toast}</div>}
    </div>
  );
}

function useLoad<T>(url: string | null, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let off = false;
    setError('');
    api<T>('GET', url).then(
      (d) => !off && setData(d),
      (e) => !off && setError(e.message),
    );
    return () => void (off = true);
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

function DirList(props: { sid: number; path: string; onRoot: (r: string) => void; onDir: (p: string) => void; onFile: (p: string) => void; onActions: (path: string, dir: boolean) => void }) {
  const { sid, path, onRoot, onActions } = props;
  const go = (p: string, dir: boolean) => (dir ? props.onDir(p) : props.onFile(p));
  const [hidden, setHidden] = useState(store.get('tw:files:hidden') === '1');
  const [find, setFind] = useState('');
  const [found, setFound] = useState<{ path: string; dir: boolean }[] | null>(null);
  const { data, error, reload } = useLoad<Listing>(`/_tw/api/sessions/${sid}/files?path=${q(path)}`, [sid, path]);
  const [rootDir, setRootDir] = useState('');
  useEffect(() => {
    if (data && !path) {
      setRootDir(data.dir);
      onRoot(data.dir);
    } else if (data && !rootDir) {
      // opened inside a subdirectory: the root is the listed dir minus the relative part
      const r = data.dir.endsWith('/' + path) ? data.dir.slice(0, -path.length - 1) : '';
      if (r) (setRootDir(r), onRoot(r));
    }
  }, [data]);

  // file name search, after a pause in typing
  useEffect(() => {
    if (!find.trim()) return setFound(null);
    const t = setTimeout(() => api<{ path: string; dir: boolean }[]>('GET', `/_tw/api/sessions/${sid}/files/search?q=${q(find.trim())}`).then(setFound, () => setFound([])), 400);
    return () => clearTimeout(t);
  }, [find, sid]);

  const entries = useMemo(() => {
    const list = (data?.entries ?? []).filter((e) => hidden || !e.name.startsWith('.'));
    return list.sort((a, b) => (a.type === 'd') !== (b.type === 'd') ? (a.type === 'd' ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));
  }, [data, hidden]);
  const crumbs = path ? path.split('/') : [];
  const rootName = baseName(rootDir) || '工作目录';

  return (
    <>
      <div class="fv-tools">
        <input class="fv-find" type="search" placeholder="搜索文件名" value={find} onInput={(e) => setFind((e.target as HTMLInputElement).value)} />
        <label class="fv-hidden dim small">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              setHidden(v);
              store.set('tw:files:hidden', v ? '1' : null);
            }}
          />
          显示隐藏文件
        </label>
      </div>
      {found ? (
        <div class="fv-list">
          {!found.length && <p class="dim small pad">没有找到</p>}
          {found.map((f) => (
            <Row key={f.path} name={f.path} dir={f.dir} onOpen={() => (setFind(''), go(f.path, f.dir))} onActions={() => onActions(f.path, f.dir)} />
          ))}
        </div>
      ) : (
        <>
          <div class="fv-crumbs">
            <button class="link" onClick={() => props.onDir('')}>
              {rootName}
            </button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <span class="dim"> / </span>
                <button class="link" onClick={() => props.onDir(crumbs.slice(0, i + 1).join('/'))}>
                  {c}
                </button>
              </span>
            ))}
            <button class="icon-btn fv-dir-more" onClick={() => onActions(path, true)} aria-label="这个目录的操作">
              <Icon.more />
            </button>
          </div>
          {error && (
            <p class="error pad">
              {error}{' '}
              <button class="link" onClick={reload}>
                重试
              </button>
            </p>
          )}
          {!data && !error && <p class="dim small pad">加载中…</p>}
          <div class="fv-list">
            {data && !entries.length && <p class="dim small pad">空目录</p>}
            {entries.map((e) => {
              const p = path ? `${path}/${e.name}` : e.name;
              return (
                <Row
                  key={e.name}
                  name={e.name + (e.link ? ' →' : '')}
                  dir={e.type === 'd'}
                  meta={e.type === 'd' ? ago(e.mtime) : `${size(e.size)} · ${ago(e.mtime)}`}
                  onOpen={() => go(p, e.type === 'd')}
                  onActions={() => onActions(p, e.type === 'd')}
                />
              );
            })}
            {data?.truncated && <p class="dim small pad">条目太多，只显示前 3000 个。可以用上面的搜索。</p>}
          </div>
        </>
      )}
    </>
  );
}

function Row({ name, dir, meta, onOpen, onActions }: { name: string; dir: boolean; meta?: string; onOpen: () => void; onActions: () => void }) {
  return (
    <div class="fv-row">
      <button class="fv-open" onClick={onOpen}>
        <span class={`fv-icon ${dir ? 'dir' : ''}`}>{dir ? <Icon.folder /> : <Icon.file />}</span>
        <span class="fv-name">{name}</span>
        {meta && <span class="fv-meta dim">{meta}</span>}
      </button>
      <button class="icon-btn fv-more" onClick={onActions} aria-label="操作">
        <Icon.more />
      </button>
    </div>
  );
}

function FileViewer({ sid, path, onActions }: { sid: number; path: string; onActions: () => void }) {
  const isImage = IMAGE.test(path);
  const isMd = MARKDOWN.test(path);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [from, setFrom] = useState(0); // offset of bytes[0]
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(store.get('tw:files:wrap') !== '0');

  const load = async (offset: number, append: boolean) => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/_tw/api/sessions/${sid}/files/read?path=${q(path)}&offset=${offset}&length=${CHUNK}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `HTTP ${r.status}`);
      const chunk = new Uint8Array(await r.arrayBuffer());
      setTotal(Number(r.headers.get('X-File-Size')) || 0);
      if (append && bytes) {
        const joined = new Uint8Array(bytes.length + chunk.length);
        joined.set(bytes);
        joined.set(chunk, bytes.length);
        setBytes(joined);
      } else {
        setBytes(chunk);
        setFrom(offset);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setBytes(null);
    if (!isImage) void load(0, false);
  }, [sid, path]);

  const binary = useMemo(() => !!bytes && bytes.subarray(0, 8000).includes(0), [bytes]);
  const text = useMemo(() => (bytes && !binary ? new TextDecoder('utf-8').decode(bytes) : ''), [bytes, binary]);
  const end = from + (bytes?.length ?? 0);
  const html = useMemo(() => (isMd && !source && text && from === 0 ? renderMarkdown(text, { sid, off: '0', base: parent(path) }) : ''), [text, isMd, source, from]);

  return (
    <div class="fv-file">
      <div class="fv-file-head">
        <span class="fv-file-name">{baseName(path)}</span>
        {total > 0 && <span class="dim small">{size(total)}</span>}
        {isMd && from === 0 && (
          <button class="ghost small" onClick={() => setSource((v) => !v)}>
            {source ? '预览' : '源码'}
          </button>
        )}
        {!isImage && !isMd && (
          <button
            class="ghost small"
            onClick={() => {
              setWrap(!wrap);
              store.set('tw:files:wrap', wrap ? '0' : null);
            }}
          >
            {wrap ? '不换行' : '自动换行'}
          </button>
        )}
        <button class="icon-btn" onClick={onActions} aria-label="操作">
          <Icon.more />
        </button>
      </div>
      {error && <p class="error pad">{error}</p>}
      {isImage ? (
        <a class="md-img fv-image" href={`/_tw/api/sessions/${sid}/file-image?path=${q(path)}`} target="_blank" rel="noopener noreferrer">
          <img src={`/_tw/api/sessions/${sid}/file-image?path=${q(path)}`} alt={path} />
        </a>
      ) : !bytes ? (
        !error && <p class="dim small pad">加载中…</p>
      ) : binary ? (
        <p class="pad dim">二进制文件，不能直接显示。可以在右上角 ⋯ 里下载。</p>
      ) : (
        <>
          {from > 0 && (
            <p class="dim small pad">
              从第 {size(from)} 处开始显示（文件末尾部分）。
              <button class="link" onClick={() => load(0, false)}>
                从头看
              </button>
            </p>
          )}
          {html ? <div class="md fv-md" dangerouslySetInnerHTML={{ __html: html }} /> : <pre class={`fv-text ${wrap ? 'wrap' : ''}`}>{text}</pre>}
          {end < total && (
            <div class="fv-more-bar">
              <button class="ghost small" disabled={loading} onClick={() => load(end, true)}>
                {loading ? '加载中…' : `继续加载（还有 ${size(total - end)}）`}
              </button>
              {from === 0 && total > CHUNK * 2 && (
                <button class="ghost small" disabled={loading} onClick={() => load(Math.max(0, total - CHUNK), false)}>
                  看末尾
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_NAME: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', '?': '新文件', U: '冲突' };
const statusOf = (s: string) => (s === '??' ? '?' : s.trim()[0] || 'M');

function ChangeList({ sid, onRoot, onOpen }: { sid: number; onRoot: (r: string) => void; onOpen: (d: Doc) => void }) {
  const { data, error, reload } = useLoad<Changes | null>(`/_tw/api/sessions/${sid}/files/changes`, [sid]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (data !== null || error) setLoaded(true);
    if (data) onRoot(data.cwd);
  }, [data, error]);
  // paths in git are relative to the repository root; the rest of the tab uses the working directory
  const rel = (p: string) => {
    if (!data) return p;
    const abs = `${data.root}/${p}`;
    return abs.startsWith(data.cwd + '/') ? abs.slice(data.cwd.length + 1) : abs;
  };
  return (
    <div class="fv-list">
      <div class="fv-crumbs">
        <span class="dim small">{data ? `${data.files.length} 个文件有改动（相对上次提交）` : ''}</span>
        <button class="ghost small" onClick={reload}>
          刷新
        </button>
      </div>
      {error && <p class="error pad">{error}</p>}
      {!loaded && !error && <p class="dim small pad">加载中…</p>}
      {loaded && !data && !error && <p class="dim pad">工作目录不在 git 仓库里，没有改动记录。</p>}
      {data && !data.files.length && <p class="dim pad">没有未提交的改动。</p>}
      {data?.files.map((f) => {
        const st = statusOf(f.status);
        const p = rel(f.path);
        return (
          <div class="fv-row" key={f.path}>
            <button class="fv-open" onClick={() => onOpen({ kind: 'diff', path: p, repoPath: f.path, status: f.status })}>
              <span class={`fv-st st-${st === '?' ? 'n' : st}`} title={STATUS_NAME[st]}>
                {st === '?' ? 'N' : st}
              </span>
              <span class="fv-name">
                {p}
                {f.from && <span class="dim small"> ← {rel(f.from)}</span>}
              </span>
              <span class="fv-meta">
                {f.added != null && <span class="add">+{f.added}</span>} {f.removed != null && <span class="del">−{f.removed}</span>}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DiffViewer({ sid, view, onActions }: { sid: number; view: Extract<Doc, { kind: 'diff' }>; onActions: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const body = useRef<HTMLPreElement>(null);
  useEffect(() => {
    setText(null);
    fetch(`/_tw/api/sessions/${sid}/files/diff?path=${q(view.repoPath)}`, { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? setText(await r.text()) : setError((await r.json().catch(() => null))?.error || `HTTP ${r.status}`)))
      .catch((e) => setError(e.message));
  }, [sid, view.repoPath]);
  // skip git's header lines; color by the first character
  const lines = (text ?? '').split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l));
  return (
    <div class="fv-file">
      <div class="fv-file-head">
        <span class="fv-file-name">{view.path}</span>
        <span class="dim small">{STATUS_NAME[statusOf(view.status)]}</span>
        <button class="icon-btn" onClick={onActions} aria-label="操作">
          <Icon.more />
        </button>
      </div>
      {error && <p class="error pad">{error}</p>}
      {text === null && !error && <p class="dim small pad">加载中…</p>}
      {text !== null && !text.trim() && <p class="dim pad">没有可显示的文本差异（可能是二进制文件或目录）。</p>}
      {text && (
        <pre class="fv-diff" ref={body}>
          {lines.map((l, i) => (
            <div key={i} class={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
