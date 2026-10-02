import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Host } from './host.js';

// Read-only file access for the files tab: everything runs on the session's host, relative to its
// working directory ($1 in every script; "~" works too).

const AT_CWD = `h() { case $1 in "~") printf '%s' "$HOME";; "~/"*) printf '%s/%s' "$HOME" "\${1#??}";; *) printf '%s' "$1";; esac; }; cd "$(h "$1")" 2>/dev/null || exit 5; `;

/** A path a viewer may see: inside the working directory. Anything else needs control access. */
export const insideCwd = (p: string) => !p.startsWith('/') && !p.startsWith('~') && !p.split('/').includes('..');

export interface Entry {
  name: string;
  /** d = directory, f = file, o = other; for links, what they point to */
  type: 'd' | 'f' | 'o';
  link: boolean;
  size: number;
  mtime: number;
}

const MAX_ENTRIES = 3000;

export async function listDir(host: Host, cwd: string, path: string): Promise<{ dir: string; entries: Entry[]; truncated: boolean }> {
  const out = await host.sh(
    AT_CWD + `d=$(h "$2"); [ -n "$d" ] || d=.; cd "$d" 2>/dev/null || exit 3; pwd; find . -mindepth 1 -maxdepth 1 -printf '%y%Y\\t%s\\t%T@\\t%f\\0' 2>/dev/null | head -z -n ${MAX_ENTRIES + 1}`,
    [cwd, path],
  );
  const nl = out.indexOf(0x0a);
  const dir = out.subarray(0, nl).toString();
  const entries: Entry[] = [];
  for (const rec of out.subarray(nl + 1).toString('utf8').split('\0')) {
    if (!rec) continue;
    const [types, size, mtime, ...name] = rec.split('\t');
    const target = types[1];
    entries.push({
      name: name.join('\t'),
      type: target === 'd' ? 'd' : target === 'f' ? 'f' : 'o',
      link: types[0] === 'l',
      size: Number(size) || 0,
      mtime: Math.round(Number(mtime) * 1000) || 0,
    });
  }
  const truncated = entries.length > MAX_ENTRIES;
  return { dir, entries: entries.slice(0, MAX_ENTRIES), truncated };
}

/** Bytes [offset, offset+length) of a file, plus its size. */
export async function readPart(host: Host, cwd: string, path: string, offset: number, length: number): Promise<{ size: number; data: Buffer }> {
  const out = await host.sh(AT_CWD + `f=$(h "$2"); [ -f "$f" ] || exit 3; wc -c < "$f"; tail -c +$(( $3 + 1 )) -- "$f" | head -c $4`, [cwd, path, String(offset), String(length)]);
  const nl = out.indexOf(0x0a);
  return { size: Number(out.subarray(0, nl).toString().trim()), data: out.subarray(nl + 1) };
}

export async function fileSize(host: Host, cwd: string, path: string): Promise<number> {
  return Number((await host.sh(AT_CWD + `f=$(h "$2"); [ -f "$f" ] || exit 3; wc -c < "$f"`, [cwd, path])).toString().trim());
}

/** The whole file as a stream (downloads of any size). */
export function streamFile(host: Host, cwd: string, path: string): ChildProcessWithoutNullStreams {
  return host.spawn(['sh', '-c', AT_CWD + `f=$(h "$2"); exec cat -- "$f"`, 'sh', cwd, path]);
}

/** File names containing `q`, below the working directory (skipping .git, node_modules, venvs). */
export async function search(host: Host, cwd: string, q: string): Promise<{ path: string; dir: boolean }[]> {
  const out = await host.sh(
    AT_CWD +
      `t=; command -v timeout >/dev/null && t='timeout 8'; ` +
      `$t find . -maxdepth 8 \\( -name .git -o -name node_modules -o -name __pycache__ -o -name .venv -o -name venv -o -name .tmux-web \\) -prune -o -iname "*$2*" -printf '%y\\t%P\\0' 2>/dev/null | head -z -n 200; exit 0`,
    [cwd, q],
  );
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((r) => ({ dir: r[0] === 'd', path: r.slice(2) }))
    .filter((r) => r.path);
}

export interface Change {
  /** relative to the repository root */
  path: string;
  /** git's two status letters, e.g. " M", "A ", "??" */
  status: string;
  from?: string;
  added?: number;
  removed?: number;
}

/** What changed in the working directory's git repository (git status + line counts). */
export async function changes(host: Host, cwd: string): Promise<{ root: string; cwd: string; files: Change[] } | null> {
  let out: Buffer;
  try {
    out = await host.sh(
      AT_CWD +
        `top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 4; printf '%s\\n' "$top"; pwd; ` +
        `git -c core.quotepath=off status --porcelain=v1 -z --untracked-files=normal 2>/dev/null | head -z -n 1000; printf '\\001'; ` +
        `git -c core.quotepath=off diff HEAD --numstat -z 2>/dev/null | head -c 300000; exit 0`,
      [cwd],
    );
  } catch (e: any) {
    if (e.code === 4) return null; // not a git repository
    throw e;
  }
  const s = out.toString('utf8');
  const [root, here] = s.split('\n', 2);
  const body = s.slice(root.length + here.length + 2);
  const sep = body.indexOf('\x01');
  const status = body.slice(0, sep).split('\0');
  const files: Change[] = [];
  for (let i = 0; i < status.length; i++) {
    const r = status[i];
    if (r.length < 4) continue;
    const c: Change = { status: r.slice(0, 2), path: r.slice(3) };
    if (c.status[0] === 'R' || c.status[0] === 'C') c.from = status[++i];
    files.push(c);
  }
  // numstat -z: "added\tremoved\tpath\0", renames "added\tremoved\t\0from\0to\0"
  const num = body.slice(sep + 1).split('\0');
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (let i = 0; i < num.length; i++) {
    const [a, d, p] = num[i].split('\t');
    if (a === undefined || d === undefined) continue;
    const path = p || (i += 2, num[i]);
    const f = byPath.get(path);
    if (f) {
      f.added = a === '-' ? undefined : Number(a);
      f.removed = d === '-' ? undefined : Number(d);
    }
  }
  return { root, cwd: here, files };
}

/** One file's diff against HEAD (new files: all lines added). `path` is relative to the repo root. */
export async function diff(host: Host, cwd: string, path: string): Promise<string> {
  const out = await host.sh(
    AT_CWD +
      `cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || exit 4; ` +
      `if git ls-files --error-unmatch -- "$2" >/dev/null 2>&1; then git -c core.quotepath=off diff HEAD -- "$2"; ` +
      `else git -c core.quotepath=off diff --no-index -- /dev/null "$2"; fi 2>/dev/null | head -c 524288; exit 0`,
    [cwd, path],
  );
  return out.toString('utf8');
}
