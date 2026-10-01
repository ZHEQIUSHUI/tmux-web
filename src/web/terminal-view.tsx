import { useEffect, useRef, useState } from 'preact/hooks';
import { coarsePointer } from './lib';
import { Icon } from './ui';

// ---------------- terminal tab ----------------

// keys a phone keyboard doesn't have, grouped like a terminal app's accessory bar
export const TERM_KEYS: ([string, string] | '|')[] = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  '|',
  ['←', '\x1b[D'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['→', '\x1b[C'],
  '|',
  ['^C', '\x03'],
  ['⏎', '\r'],
  ['⇧Tab', '\x1b[Z'],
  '|',
  ['/', '/'],
  ['-', '-'],
  ['|', '|'],
  ['~', '~'],
  [':', ':'],
  ['*', '*'],
];

export function TerminalView({ sessionId, canWrite }: { sessionId: number; canWrite: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const handle = useRef<import('./terminal').TermHandle | null>(null);
  const [state, setState] = useState('加载终端…');
  const [mods, setMods] = useState({ ctrl: false, alt: false });
  const [kb, setKb] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import('./terminal')
      .then(({ mountTerminal }) => {
        if (cancelled || !el.current) return;
        handle.current = mountTerminal(el.current, sessionId, setState, () => setMods({ ctrl: false, alt: false }));
        // on phones, focusing would pop the keyboard over the screen right away
        if (!coarsePointer) handle.current.focus();
      })
      // the page is older than the server's current build and its chunk is gone
      .catch(() => !cancelled && setState('stale'));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
    };
  }, [sessionId]);
  const toggleMod = (k: 'ctrl' | 'alt') => {
    const next = { ...mods, [k]: !mods[k] };
    setMods(next);
    handle.current?.setModifiers(next);
  };
  const paste = async () => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // clipboard API needs https; fall back to the system paste menu in a prompt
      text = prompt('粘贴要发送到终端的内容');
    }
    if (text) handle.current?.send(text);
  };
  // keep focus where it is: tapping a key must not close (or open) the phone keyboard
  const noBlur = (e: Event) => e.preventDefault();
  return (
    <div class="term-col">
      <div class="term-wrap">
        {state === 'stale' ? (
          <div class="term-state">
            网页已更新，
            <button class="link" onClick={() => location.reload()}>
              点此刷新
            </button>
          </div>
        ) : (
          state && <div class="term-state">{state}</div>
        )}
        <div class="term" ref={el} />
      </div>
      {coarsePointer && canWrite && (
        <div class="acc-bar">
          <button class={`acc kb ${kb ? 'on' : ''}`} aria-label="键盘" onMouseDown={noBlur} onClick={() => setKb(!!handle.current?.toggleKeyboard())}>
            <Icon.keys />
          </button>
          <div class="acc-scroll">
            <button class={`acc ${mods.ctrl ? 'on' : ''}`} onMouseDown={noBlur} onClick={() => toggleMod('ctrl')}>
              Ctrl
            </button>
            <button class={`acc ${mods.alt ? 'on' : ''}`} onMouseDown={noBlur} onClick={() => toggleMod('alt')}>
              Alt
            </button>
            {TERM_KEYS.map((k, i) =>
              k === '|' ? (
                <span key={i} class="acc-sep" />
              ) : (
                <button key={k[0]} class="acc" onMouseDown={noBlur} onClick={() => handle.current?.send(k[1])}>
                  {k[0]}
                </button>
              ),
            )}
            <span class="acc-sep" />
            <button class="acc" onMouseDown={noBlur} onClick={paste}>
              粘贴
            </button>
            <button class="acc" onMouseDown={noBlur} onClick={() => handle.current?.zoom(-1)}>
              A−
            </button>
            <button class="acc" onMouseDown={noBlur} onClick={() => handle.current?.zoom(1)}>
              A+
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
