import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type SessionInfo } from './api';
import { store } from './lib';

/** "5173", "5173/docs", ":5173/x", "localhost:5173/x?a=1", "http://127.0.0.1:5173/" → port + path */
export function parseTarget(input: string): { port: number; path: string } | null {
  const m = /^\s*(?:https?:\/\/)?(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])?:)?(\d{1,5})(\/[^\s]*)?\s*$/.exec(input);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? { port, path: m[2] || '/' } : null;
}

export interface PortInfo {
  port: number;
  addr: string;
  proc?: string;
}

/** Shows a web app running on the session's host (served through tmux-web's /p/ proxy). */
export function PreviewView({ session }: { session: SessionInfo }) {
  const key = `tw:pv:${session.id}`;
  const [input, setInput] = useState(() => store.get(key) || '');
  const [src, setSrc] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [allPorts, setAllPorts] = useState(false);
  const [err, setErr] = useState('');
  const loadPorts = useCallback(() => {
    api<PortInfo[]>('GET', `/_tw/api/hosts/${session.hostId}/ports`).then(setPorts, (e) => {
      setPorts([]);
      setErr(e.message);
    });
  }, [session.hostId]);
  const open = (value: string) => {
    const t = parseTarget(value);
    if (!t) return setErr('请输入端口，可以带路径，例如 5173 或 5173/docs');
    setErr('');
    setInput(value.trim());
    store.set(key, value.trim());
    setSrc(`/p/${session.hostId}/${t.port}${t.path}`);
    setNonce((n) => n + 1);
  };
  useEffect(() => {
    loadPorts();
    const saved = store.get(key);
    if (saved && parseTarget(saved)) open(saved);
  }, [session.id]);
  return (
    <div class="preview">
      <form
        class="pv-bar"
        onSubmit={(e) => {
          e.preventDefault();
          open(input);
        }}
      >
        <span class="pv-host dim">{session.host}:</span>
        <input value={input} onInput={(e) => setInput((e.target as HTMLInputElement).value)} placeholder="端口/路径，如 5173/docs" autocapitalize="off" spellcheck={false} inputMode="url" />
        <button class="primary">打开</button>
        {src && (
          <>
            <button type="button" title="刷新" onClick={() => setNonce((n) => n + 1)}>
              ↻
            </button>
            <a class="btn" href={src} target="_blank" rel="noopener" title="在新窗口打开">
              ↗
            </a>
          </>
        )}
      </form>
      {err && <div class="banner error">{err}</div>}
      {src ? (
        <iframe key={nonce} class="pv-frame" src={src} title="预览" />
      ) : (
        <div class="pv-empty">
          <p class="dim">输入 agent 启动的网页端口（可以带路径），会通过 tmux-web 转发显示在这里，不需要另外开放端口。</p>
          <div class="pv-ports">
            <span class="dim small">{session.host} 上正在监听的端口：</span>
            {ports === null && <span class="dim small">读取中…</span>}
            {ports?.length === 0 && <span class="dim small">没有</span>}
            {/* the process name is only visible for the SSH user's own processes: those are the agent's */}
            {ports?.filter((p) => allPorts || p.proc || !ports.some((x) => x.proc)).map((p) => (
              <button key={p.port} class="chip on" onClick={() => open(String(p.port))}>
                {p.port}
                {p.proc ? ` · ${p.proc}` : ''}
              </button>
            ))}
            {ports?.some((p) => !p.proc) && ports.some((p) => p.proc) && (
              <button class="link" onClick={() => setAllPorts((v) => !v)}>
                {allPorts ? '只看我的' : `全部 (${ports.length})`}
              </button>
            )}
            <button class="link" onClick={loadPorts}>
              刷新
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
