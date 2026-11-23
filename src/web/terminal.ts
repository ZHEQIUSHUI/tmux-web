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
  let dbg: ((l: string) => void) | null = null;
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
    dbg?.(`send ${JSON.stringify(d)} ws=${ws?.readyState} write=${canWrite}`);
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

  let sent = 0;
  const typed = (d: string) => {
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
  };
  term.onData((d) => {
    sent++;
    typed(d);
  });

  // iPhone keyboards: each key first sends a keydown xterm can't read (key "Unidentified"), and
  // xterm then drops the text in the input event that follows, since a keydown was seen; words
  // picked from the IME may not get through either. Whatever the textarea receives that xterm
  // didn't send, we send.
  const ta = el.querySelector('textarea')!;
  let sentAtKey = 0;
  let imeKey = false;
  // a composition just ended: its text is sent (or checked) by the compositionend handler
  let composed = false;
  const missed = (d: string, at: number) => sent === at && typed(d);
  ta.addEventListener('keydown', (e) => {
    sentAtKey = sent;
    imeKey = e.keyCode === 229;
    composed = false;
  }, true);
  ta.addEventListener('compositionstart', () => {
    composed = false;
  }, true);
  ta.addEventListener('keyup', () => {
    imeKey = false;
  }, true);
  // registered after xterm's own listeners, so it has had its chance at this event
  ta.addEventListener('input', (e) => {
    const ev = e as InputEvent;
    if (ev.isComposing || imeKey || composed) return;
    const d = ev.inputType === 'insertText' ? ev.data : ev.inputType === 'insertLineBreak' ? '\r' : ev.inputType === 'deleteContentBackward' ? '\x7f' : null;
    if (d) missed(d, sentAtKey);
    // the next input without a keydown of its own is compared from here
    sentAtKey = sent;
  }, true);
  // xterm sends a finished composition a moment later; check after that
  ta.addEventListener('compositionend', (e) => {
    const d = e.data;
    const at = sent;
    composed = true;
    if (d) setTimeout(() => missed(d, at), 50);
  }, true);

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
  // one finger up or down scrolls back through the output (xterm.js has no touch scrolling), and
  // keeps gliding a little when let go
  let swipe: { x: number; y: number; on: boolean; rest: number; v: number; t: number } | null = null;
  let glide = 0;
  const rowHeight = () => (el.querySelector('.xterm-screen')?.clientHeight || 0) / term.rows || 16;
  const scrollBy = (px: number) => {
    if (!swipe) return;
    const h = rowHeight();
    swipe.rest += px;
    const n = Math.trunc(swipe.rest / h);
    if (n) {
      term.scrollLines(n);
      swipe.rest -= n * h;
    }
  };
  const onTouchStart = (e: TouchEvent) => {
    cancelAnimationFrame(glide);
    swipe = null;
    if (e.touches.length === 2) pinch = { dist: dist(e.touches), size: term.options.fontSize! };
    else if (e.touches.length === 1) swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false, rest: 0, v: 0, t: e.timeStamp };
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const target = pinch.size * (dist(e.touches) / pinch.dist);
      if (Math.abs(target - term.options.fontSize!) >= 0.5) zoom(target - term.options.fontSize!);
      return;
    }
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    if (!swipe.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // sideways is the page's (a wider adopted terminal pans, the edge swipe goes back); so is
      // up and down while a taller adopted terminal can still move that way
      const pans = fixedSize && el.scrollHeight > el.clientHeight;
      if (Math.abs(dx) > Math.abs(dy) || pans) return void (swipe = null);
      swipe.on = true;
    }
    e.preventDefault();
    const dt = Math.max(1, e.timeStamp - swipe.t);
    swipe.v = -dy / dt;
    swipe.x = t.clientX;
    swipe.y = t.clientY;
    swipe.t = e.timeStamp;
    // finger down: earlier output
    scrollBy(-dy);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) pinch = null;
    if (!swipe?.on || e.touches.length) return;
    let v = swipe.v;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      scrollBy(v * dt);
      v *= Math.pow(0.995, dt);
      if (Math.abs(v) > 0.05) glide = requestAnimationFrame(step);
    };
    if (Math.abs(v) > 0.3) glide = requestAnimationFrame(step);
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

  // temporary keyboard diagnostics: open the page with ?kbdebug=1
  if (/[?&]kbdebug/.test(location.search)) {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:0;right:0;top:0;max-height:45%;overflow:auto;z-index:50;background:rgba(0,0,0,.85);color:#7f7;font:11px/1.3 monospace;white-space:pre-wrap;padding:4px;';
    const copy = document.createElement('button');
    copy.textContent = '复制';
    copy.style.cssText = 'position:sticky;top:0;float:right;';
    const pre = document.createElement('div');
    box.append(copy, pre);
    el.parentElement!.append(box);
    const lines: string[] = [navigator.userAgent];
    dbg = (l: string) => {
      lines.push(l);
      if (lines.length > 200) lines.splice(1, 1);
      pre.textContent = lines.slice(-25).join('\n');
    };
    copy.onclick = () => {
      const text = lines.join('\n');
      navigator.clipboard?.writeText(text).then(() => (copy.textContent = '已复制'), () => prompt('复制下面的内容', text));
    };
    const at = () => (document.activeElement === ta ? 'ta' : document.activeElement?.tagName.toLowerCase());
    for (const t of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'focus', 'blur']) {
      ta.addEventListener(t, (e: any) => {
        dbg!(`${t} key=${e.key ?? ''} code=${e.keyCode ?? ''} type=${e.inputType ?? ''} data=${JSON.stringify(e.data ?? null)} comp=${e.isComposing ?? ''} val=${JSON.stringify(ta.value.slice(-8))} prevented=${e.defaultPrevented} focus=${at()}`);
      }, true);
    }
    document.addEventListener('focusin', () => dbg!(`focusin ${at()}`));
    dbg(`start focus=${at()}`);
  }

  const input = () => el.querySelector('textarea');

  return {
    dispose() {
      disposed = true;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('online', onVisible);
      clearTimeout(pongTimer);
      ws?.close();
      cancelAnimationFrame(glide);
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
