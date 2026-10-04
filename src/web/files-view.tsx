import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './api';
import { ago, copyText, store } from './lib';
import { renderMarkdown } from './markdown';
import { CopyBtn, Icon, Modal } from './ui';

// File browser: a session's working directory (files tab) or a whole host (global browser). Read
// files, see what changed in git, hand paths to the agent. Read-only on purpose: changes go
// through the agent.

/** What the browser looks at. */
export interface FilesTarget {
  /** route prefix: /_tw/api/sessions/<id> or /_tw/api/hosts/<id> */
  api: string;
  /** remembers where you were, per target */
  key: string;
  /** a whole host: starts in the home directory and may go to "/" */
  global: boolean;
  /** how a path is written into the agent's input box; absent = no "insert" */
  mention?: (p: string) => string;
  onInsert?: (text: string) => void;
  /** start a new session in this (absolute) directory */
  onNewHere?: (dir: string) => void;
}

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
/**
 * An open file, or one changed file's diff. Paths are relative to the base (working directory or
 * home) or absolute; a diff's repoPath is relative to the repository of `dir`.
 */
type Doc = { kind: 'file'; path: string } | { kind: 'diff'; path: string; repoPath: string; dir: string; status: string };

/** Where you were in each browser, kept while the page is open. */
const places = new Map<string, { mode: 'files' | 'changes'; dir: string; doc: Doc | null }>();

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const CHUNK = 64 * 1024;

export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
/** Parent directory; keeps "/" for absolute paths. */
const parent = (p: string) => {
  const up = p.split('/').slice(0, -1).join('/');
  return !up && p.startsWith('/') ? '/' : up;
};
const below = (dir: string, name: string) => (!dir ? name : dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const baseName = (p: string) => p.split('/').pop() || p;
const q = (p: string) => encodeURIComponent(p);

export function FilesView({ target }: { target: FilesTarget }) {
  const saved = places.get(target.key);
  const [mode, setMode] = useState<'files' | 'changes'>(saved?.mode ?? 'files');
  const [dir, setDir] = useState(saved?.dir ?? '');
  const [doc, setDoc] = useState<Doc | null>(saved?.doc ?? null);
  const [root, setRoot] = useState(''); // absolute base directory, for full paths
  const [actions, setActions] = useState<{ path: string; dir: boolean } | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => void places.set(target.key, { mode, dir, doc }), [target.key, mode, dir, doc]);
  const top = () => document.querySelector('.fv-body')?.scrollTo(0, 0);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? '' : x)), 1600);
  };
  const full = (p: string) => (p.startsWith('/') ? p : !root ? p || '.' : p ? `${root}/${p}` : root);
  const act = {
    copy: async (text: string) => flash((await copyText(text)) ? '已复制' : '复制失败，请长按手动复制'),
    download: (p: string) => {
      const a = document.createElement('a');
      a.href = `${target.api}/files/download?path=${q(p)}`;
      a.download = baseName(p);
      a.click();
    },
  };
  const openDir = (p: string) => (setDir(p), setDoc(null), top());
  const openDoc = (d: Doc) => (setDoc(d), top());
  const a = actions;

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
          <FileViewer api={target.api} path={doc.path} onActions={() => setActions({ path: doc.path, dir: false })} />
        ) : doc?.kind === 'diff' ? (
          <DiffViewer api={target.api} view={doc} onActions={() => setActions({ path: doc.path, dir: false })} />
        ) : mode === 'changes' ? (
          <ChangeList target={target} dir={dir} onOpen={openDoc} />
        ) : (
          <DirList target={target} path={dir} onRoot={setRoot} onDir={openDir} onFile={(p) => openDoc({ kind: 'file', path: p })} onActions={(path, d) => setActions({ path, dir: d })} />
        )}
      </div>
      {a && (
        <Modal title={full(a.path)} onClose={() => setActions(null)}>
          <div class="sheet-list">
            {target.mention && target.onInsert && (
              <button onClick={() => (setActions(null), target.onInsert!(target.mention!(a.path)))}>
                插入到输入框<span class="check dim fv-ell">{target.mention(a.path)}</span>
              </button>
            )}
            {!target.global && !a.path.startsWith('/') && <button onClick={() => (setActions(null), act.copy(a.path || '.'))}>复制相对路径</button>}
            <button onClick={() => (setActions(null), act.copy(full(a.path)))}>
              复制完整路径<span class="check dim fv-ell">{full(a.path)}</span>
            </button>
            {a.dir && target.onNewHere && <button onClick={() => (setActions(null), target.onNewHere!(full(a.path)))}>在这里新建会话</button>}
            {!a.dir && <button onClick={() => (setActions(null), act.download(a.path))}>下载</button>}
          </div>
        </Modal>
      )}
      {toast && <div class="fv-toast">{toast}</div>}
    </div>
  );
}

function useLoad<T>(url: string, deps: unknown[]): { data: T | null; loaded: boolean; error: string; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; loaded: boolean; error: string }>({ data: null, loaded: false, error: '' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    setState({ data: null, loaded: false, error: '' });
    api<T>('GET', url).then(
      (data) => !off && setState({ data, loaded: true, error: '' }),
      (e) => !off && setState({ data: null, loaded: true, error: e.message }),
    );
    return () => void (off = true);
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

function DirList(props: { target: FilesTarget; path: string; onRoot: (r: string) => void; onDir: (p: string) => void; onFile: (p: string) => void; onActions: (path: string, dir: boolean) => void }) {
  const { target, path, onRoot, onActions } = props;
  const go = (p: string, dir: boolean) => (dir ? props.onDir(p) : props.onFile(p));
  const [hidden, setHidden] = useState(store.get('tw:files:hidden') === '1');
  const [find, setFind] = useState('');
  const [found, setFound] = useState<{ path: string; dir: boolean }[] | null>(null);
  const { data, error, reload } = useLoad<Listing>(`${target.api}/files?path=${q(path)}`, [target.api, path]);
  const [rootDir, setRootDir] = useState('');
  useEffect(() => {
    if (!data || path.startsWith('/')) return;
    // the base directory: the listing of '' itself, or the listed dir minus the relative part
    const r = !path ? data.dir : data.dir.endsWith('/' + path) ? data.dir.slice(0, -path.length - 1) : '';
    if (r && r !== rootDir) (setRootDir(r), onRoot(r));
  }, [data]);
  // the base directory is needed for full paths even when the tab opens deeper or elsewhere
  useEffect(() => {
    if (rootDir || !path) return;
    api<Listing>('GET', `${target.api}/files?path=`).then((d) => (setRootDir(d.dir), onRoot(d.dir)), () => {});
  }, [target.api]);

  // file name search below the current directory, after a pause in typing
  useEffect(() => {
    if (!find.trim()) return setFound(null);
    const t = setTimeout(() => api<{ path: string; dir: boolean }[]>('GET', `${target.api}/files/search?dir=${q(path)}&q=${q(find.trim())}`).then(setFound, () => setFound([])), 400);
    return () => clearTimeout(t);
  }, [find, target.api, path]);

  const entries = useMemo(() => {
    const list = (data?.entries ?? []).filter((e) => hidden || !e.name.startsWith('.'));
    return list.sort((a, b) => ((a.type === 'd') !== (b.type === 'd') ? (a.type === 'd' ? -1 : 1) : a.name.localeCompare(b.name, 'zh')));
  }, [data, hidden]);
  const absolute = path.startsWith('/');
  const crumbs = (absolute ? path.slice(1) : path).split('/').filter(Boolean);
  const crumbPath = (i: number) => (absolute ? '/' : '') + crumbs.slice(0, i + 1).join('/');
  const rootName = absolute ? '/' : target.global ? '~' : baseName(rootDir) || '工作目录';

  return (
    <>
      <div class="fv-tools">
        <input class="fv-find" type="search" placeholder={path ? '在当前目录搜索文件名' : '搜索文件名'} value={find} onInput={(e) => setFind((e.target as HTMLInputElement).value)} />
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
            <button class="link" onClick={() => props.onDir(absolute ? '/' : '')}>
              {rootName}
            </button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <span class="dim">{i || !absolute ? ' / ' : ''}</span>
                <button class="link" onClick={() => props.onDir(crumbPath(i))}>
                  {c}
                </button>
              </span>
            ))}
            <span class="fv-crumb-end">
              {target.global && (
                <>
                  <button class={`ghost small ${!absolute ? 'on' : ''}`} onClick={() => props.onDir('')} title="主目录">
                    ~
                  </button>
                  <button class={`ghost small ${absolute ? 'on' : ''}`} onClick={() => props.onDir('/')} title="根目录">
                    /
                  </button>
                </>
              )}
              <button class="icon-btn" onClick={() => onActions(path, true)} aria-label="这个目录的操作">
                <Icon.more />
              </button>
            </span>
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
              const p = below(path, e.name);
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

function FileViewer({ api: base, path, onActions }: { api: string; path: string; onActions: () => void }) {
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
      const r = await fetch(`${base}/files/read?path=${q(path)}&offset=${offset}&length=${CHUNK}`, { credentials: 'same-origin' });
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
  }, [base, path]);

  const binary = useMemo(() => !!bytes && bytes.subarray(0, 8000).includes(0), [bytes]);
  const text = useMemo(() => (bytes && !binary ? new TextDecoder('utf-8').decode(bytes) : ''), [bytes, binary]);
  const end = from + (bytes?.length ?? 0);
  const html = useMemo(() => (isMd && !source && text && from === 0 ? renderMarkdown(text, { api: base, off: '0', base: parent(path) }) : ''), [text, isMd, source, from]);
  const img = `${base}/file-image?path=${q(path)}`;

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
        {text && <CopyBtn class="ghost small" label="复制内容" text={text} title={end < total ? '复制已加载的部分' : '复制全部内容'} />}
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
        <a class="md-img fv-image" href={img} target="_blank" rel="noopener noreferrer">
          <img src={img} alt={path} />
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

function ChangeList({ target, dir, onOpen }: { target: FilesTarget; dir: string; onOpen: (d: Doc) => void }) {
  // a session: the working directory's repository; the global browser: the current directory's
  const at = target.global ? dir : '';
  const { data, loaded, error, reload } = useLoad<Changes | null>(`${target.api}/files/changes?dir=${q(at)}`, [target.api, at]);
  const none = loaded && !error && !data; // not a git repository
  // git paths are relative to the repository root; sessions use paths below their working directory
  const rel = (p: string) => {
    if (!data) return p;
    const abs = `${data.root}/${p}`;
    return !target.global && abs.startsWith(data.cwd + '/') ? abs.slice(data.cwd.length + 1) : abs;
  };
  return (
    <div class="fv-list">
      <div class="fv-crumbs">
        <span class="dim small">{data ? `${data.root.split('/').pop()}：${data.files.length} 个文件有改动（相对上次提交）` : ''}</span>
        <span class="fv-crumb-end">
          <button class="ghost small" onClick={reload}>
            刷新
          </button>
        </span>
      </div>
      {error && <p class="error pad">{error}</p>}
      {!loaded && <p class="dim small pad">加载中…</p>}
      {none && <p class="dim pad">{target.global ? '当前目录不在 git 仓库里。先在「文件」里进入一个仓库目录。' : '工作目录不在 git 仓库里，没有改动记录。'}</p>}
      {data && !data.files.length && <p class="dim pad">没有未提交的改动。</p>}
      {data?.files.map((f) => {
        const st = statusOf(f.status);
        const p = rel(f.path);
        return (
          <div class="fv-row" key={f.path}>
            <button class="fv-open" onClick={() => onOpen({ kind: 'diff', path: p, repoPath: f.path, dir: at, status: f.status })}>
              <span class={`fv-st st-${st === '?' ? 'n' : st}`} title={STATUS_NAME[st]}>
                {st === '?' ? 'N' : st}
              </span>
              <span class="fv-name">
                {target.global ? f.path : p}
                {f.from && <span class="dim small"> ← {f.from}</span>}
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

function DiffViewer({ api: base, view, onActions }: { api: string; view: Extract<Doc, { kind: 'diff' }>; onActions: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setText(null);
    fetch(`${base}/files/diff?dir=${q(view.dir)}&path=${q(view.repoPath)}`, { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? setText(await r.text()) : setError((await r.json().catch(() => null))?.error || `HTTP ${r.status}`)))
      .catch((e) => setError(e.message));
  }, [base, view.repoPath, view.dir]);
  // skip git's header lines; color by the first character
  const lines = (text ?? '').split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l));
  return (
    <div class="fv-file">
      <div class="fv-file-head">
        <span class="fv-file-name">{baseName(view.path)}</span>
        <span class="dim small">{STATUS_NAME[statusOf(view.status)]}</span>
        {text && <CopyBtn class="ghost small" label="复制" text={text} title="复制这份 diff" />}
        <button class="icon-btn" onClick={onActions} aria-label="操作">
          <Icon.more />
        </button>
      </div>
      {error && <p class="error pad">{error}</p>}
      {text === null && !error && <p class="dim small pad">加载中…</p>}
      {text !== null && !text.trim() && <p class="dim pad">没有可显示的文本差异（可能是二进制文件或目录）。</p>}
      {text && (
        <pre class="fv-diff">
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
