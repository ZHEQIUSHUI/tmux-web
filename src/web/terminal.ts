// Loaded on demand (separate chunk): xterm.js is the heaviest asset, so the chat view never pays for it.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TermHandle {
  dispose(): void;
  focus(): void;
  fit(): void;
  /** send raw input, as if typed */
  send(data: string): void;
  /** sticky Ctrl for on-screen keyboards: the next typed letter is sent as Ctrl+letter */
  setCtrl(on: boolean): void;
}

export function mountTerminal(el: HTMLElement, sessionId: number, onState: (s: string) => void, onCtrlUsed: () => void): TermHandle {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const narrow = matchMedia('(max-width: 760px)').matches;
  const term = new Terminal({
    fontSize: narrow ? 11.5 : 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
    cursorBlink: true,
    scrollback: 2000,
    theme: dark ? { background: '#16181d', foreground: '#d8dce3' } : { background: '#fbfbfa', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#c8d7f0' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  let ws: WebSocket | null = null;
  let disposed = false;
  let retry = 0;
  let canWrite = false;
  let ctrl = false;
  let pongTimer = 0;
  const enc = new TextEncoder();

  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN && canWrite) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const sendInput = (d: string) => {
    if (ws?.readyState === WebSocket.OPEN && canWrite) ws.send(enc.encode(d));
  };

  const connect = () => {
    if (disposed) return;
    onState('连接中…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/_tw/api/sessions/${sessionId}/term`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    let first = true;
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pong') clearTimeout(pongTimer);
        if (msg.type === 'hello') {
          canWrite = msg.canWrite;
          retry = 0;
          onState(canWrite ? '' : '只读');
          // adopt the pane's size for the snapshot, then ask for ours
          term.resize(msg.cols, msg.rows);
        }
        return;
      }
      const data = new Uint8Array(ev.data);
      if (first) {
        first = false;
        term.reset();
        term.write(data, () => {
          fit.fit();
          sendResize();
        });
      } else term.write(data);
    };
    sock.onclose = (ev) => {
      if (disposed || ws !== sock) return;
      if (ev.code === 4000) return onState(ev.reason === 'offline' ? '主机离线' : '会话已结束');
      onState('已断开，重连中…');
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  };

  // Phones freeze background tabs; a socket can look open but be dead. Ping when we come back.
  const onVisible = () => {
    if (document.hidden || disposed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) return connect();
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    clearTimeout(pongTimer);
    pongTimer = window.setTimeout(() => {
      const dead = ws;
      ws = null;
      dead?.close();
      connect();
    }, 3000);
  };
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('online', onVisible);

  term.onData((d) => {
    if (ctrl && d.length === 1) {
      const c = d.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
      ctrl = false;
      onCtrlUsed();
    }
    sendInput(d);
  });
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!el.clientWidth) return;
      const { cols, rows } = term;
      fit.fit();
      if (cols !== term.cols || rows !== term.rows) sendResize();
    }, 150);
  });
  ro.observe(el);
  connect();

  return {
    dispose() {
      disposed = true;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('online', onVisible);
      clearTimeout(pongTimer);
      ws?.close();
      term.dispose();
    },
    focus: () => term.focus(),
    fit: () => fit.fit(),
    // no focus here: tapping arrows to walk a menu shouldn't pop up the phone keyboard
    send: (d) => sendInput(d),
    setCtrl: (on) => {
      ctrl = on;
      term.focus();
    },
  };
}
