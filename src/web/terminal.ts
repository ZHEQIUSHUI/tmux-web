// Loaded on demand (separate chunk): xterm.js is the heaviest asset, so the chat view never pays for it.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TermHandle {
  dispose(): void;
  focus(): void;
  fit(): void;
  /** send raw input, as if typed */
  send(data: string): void;
  /** sticky modifiers for on-screen keyboards: applied to the next typed key */
  setModifiers(m: { ctrl: boolean; alt: boolean }): void;
  /** show/hide the phone keyboard (focus/blur the terminal's input) */
  toggleKeyboard(): boolean;
  /** change the font size by delta (pixels); returns the new size */
  zoom(delta: number): number;
}

const FONT_KEY = 'tw:term-font';
const MIN_FONT = 7;
const MAX_FONT = 24;

function savedFont(narrow: boolean): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY + (narrow ? ':m' : '')));
    if (v >= MIN_FONT && v <= MAX_FONT) return v;
  } catch {
    /* storage unavailable */
  }
  return narrow ? 11.5 : 13;
}

export function mountTerminal(el: HTMLElement, sessionId: number, onState: (s: string) => void, onModifiersUsed: () => void): TermHandle {
  const narrow = matchMedia('(max-width: 760px)').matches;
  // always dark, like a real terminal app: agent TUIs are designed for it
  const term = new Terminal({
    fontSize: savedFont(narrow),
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
    cursorBlink: true,
    scrollback: 2000,
    theme: { background: '#14161b', foreground: '#d8dce3', cursor: '#d8dce3', selectionBackground: '#3a4a66' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  let ws: WebSocket | null = null;
  let disposed = false;
  let retry = 0;
  let canWrite = false;
  let mods = { ctrl: false, alt: false };
  let pongTimer = 0;
  // adopted tmux sessions: the size is the user's own terminal's; we show it as is (scrolling if wider)
  let fixedSize = false;
  const enc = new TextEncoder();

  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN && canWrite && !fixedSize) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const sendInput = (d: string) => {
    if (ws?.readyState === WebSocket.OPEN && canWrite) ws.send(enc.encode(d));
  };
  const refit = () => {
    if (fixedSize || !el.clientWidth) return;
    const { cols, rows } = term;
    fit.fit();
    if (cols !== term.cols || rows !== term.rows) sendResize();
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
        if (msg.type === 'size') term.resize(msg.cols, msg.rows);
        if (msg.type === 'hello') {
          canWrite = msg.canWrite;
          fixedSize = !!msg.fixedSize;
          el.classList.toggle('fixed', fixedSize);
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
          if (fixedSize) return;
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
    if ((mods.ctrl || mods.alt) && d.length === 1) {
      if (mods.ctrl) {
        const c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
        else if (d === ' ') d = '\x00';
        else if (d === '[') d = '\x1b';
      }
      if (mods.alt) d = '\x1b' + d;
      mods = { ctrl: false, alt: false };
      onModifiersUsed();
    }
    sendInput(d);
  });

  const zoom = (delta: number) => {
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round((term.options.fontSize! + delta) * 2) / 2));
    term.options.fontSize = size;
    try {
      localStorage.setItem(FONT_KEY + (narrow ? ':m' : ''), String(size));
    } catch {
      /* storage unavailable */
    }
    refit();
    return size;
  };

  // pinch to zoom the font, like a native terminal app
  let pinch: { dist: number; size: number } | null = null;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) pinch = { dist: dist(e.touches), size: term.options.fontSize! };
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const target = pinch.size * (dist(e.touches) / pinch.dist);
    if (Math.abs(target - term.options.fontSize!) >= 0.5) zoom(target - term.options.fontSize!);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) pinch = null;
  };
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd);

  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(refit, 150);
  });
  ro.observe(el);
  connect();

  const input = () => el.querySelector('textarea');

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
    fit: refit,
    // no focus here: tapping arrows to walk a menu shouldn't pop up the phone keyboard
    send: (d) => sendInput(d),
    setModifiers: (m) => {
      mods = m;
      if (m.ctrl || m.alt) term.focus();
    },
    toggleKeyboard: () => {
      if (document.activeElement === input()) {
        term.blur();
        return false;
      }
      term.focus();
      return true;
    },
    zoom,
  };
}
