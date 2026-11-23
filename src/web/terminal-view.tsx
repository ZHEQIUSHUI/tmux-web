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

// iPhone and iPad: the keyboard's text never reaches xterm's own input (a transparent textarea
// tucked behind the screen; iOS sends it the Enter key but no letters), so these type into a
// visible input of ours instead, each character going to the terminal as soon as it's typed
const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// kept in the box so a backspace on an "empty" box still has something to delete
const KEEP = '\u200b';

export function TerminalView({ sessionId, canWrite }: { sessionId: number; canWrite: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const handle = useRef<import('./terminal').TermHandle | null>(null);
  const [state, setState] = useState('加载终端…');
  const [mods, setMods] = useState({ ctrl: false, alt: false });
  const [kb, setKb] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  // send what was typed into the box and leave just the placeholder character in it
  const flush = () => {
    const b = box.current;
    if (!b || composing.current) return;
    const v = b.value;
    if (v === KEEP) return;
    if (!v.includes(KEEP)) handle.current?.send('\x7f');
    const text = v.split(KEEP).join('');
    if (text) handle.current?.type(text);
    b.value = KEEP;
    b.setSelectionRange(1, 1);
  };
  const onBoxKey = (e: KeyboardEvent) => {
    if (composing.current || e.isComposing || e.keyCode === 229) return;
    const k = ({ Enter: '\r', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D' } as Record<string, string>)[e.key];
    if (!k) return;
    e.preventDefault();
    handle.current?.send(k);
  };
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
    // setModifiers focuses xterm's own input, which doesn't get the iPhone's letters
    if (ios && (next.ctrl || next.alt)) box.current?.focus();
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
        <div
          class="term"
          ref={el}
          // the box keeps the keyboard: xterm mustn't take the focus back on a tap
          onMouseDownCapture={ios && canWrite ? (e) => (e.stopPropagation(), e.preventDefault()) : undefined}
          onClick={ios && canWrite ? () => box.current?.focus() : undefined}
        />
      </div>
      {coarsePointer && canWrite && (
        <div class="acc-bar">
          {ios ? (
            <input
              ref={box}
              class="acc-input"
              placeholder="打字"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              enterkeyhint="send"
              onFocus={() => {
                const b = box.current!;
                if (!b.value) b.value = KEEP;
              }}
              onBlur={() => {
                const b = box.current!;
                if (b.value === KEEP) b.value = '';
              }}
              onInput={flush}
              onKeyDown={onBoxKey}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => {
                composing.current = false;
                setTimeout(flush, 0);
              }}
            />
          ) : (
            <button class={`acc kb ${kb ? 'on' : ''}`} aria-label="键盘" onMouseDown={noBlur} onClick={() => setKb(!!handle.current?.toggleKeyboard())}>
              <Icon.keys />
            </button>
          )}
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
