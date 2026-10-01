import xtermHeadless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import type { PaneCapture } from './backend/types.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializePkg;

export type AgentStatus = 'starting' | 'idle' | 'busy' | 'waiting' | 'offline' | 'dead';

const BUSY = /esc to interrupt/i;
// permission prompts / pickers of Claude Code and Codex
const WAITING = [/Do you want to /, /^\s*[❯›>]\s*\d+\.\s/m, /Enter to confirm/, /\(y\/n\)/i, /Press enter to continue/i, /Yes, (allow|proceed)/i];
const MODES: [RegExp, string][] = [
  [/bypass permissions on/i, 'bypassPermissions'],
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
];
const SEPARATOR = /^\s*[─━═╌┄\-]{10,}\s*$/;
const BOX_EDGE = /^\s*[╭╰┌└][─━]+[╮╯┐┘]\s*$/;
const PROMPT_LINE = /^\s*[│|]?\s*[❯›>](\s|$)/;
const NOISE = [/tmux detected · scroll with/];

/**
 * Server-side terminal emulator mirroring a pane. Gives us the exact current screen without
 * asking tmux, which feeds both the live preview of the chat view and the web terminal snapshot.
 */
export class Screen {
  private term;
  private serializer;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols() {
    return this.term.cols;
  }
  get rows() {
    return this.term.rows;
  }

  /** Start from what tmux currently shows; control mode only reports output from now on. */
  seed(cap: PaneCapture) {
    if (cap.cols !== this.cols || cap.rows !== this.rows) this.term.resize(cap.cols, cap.rows);
    const body = cap.text.replace(/\n$/, '').split('\n').join('\r\n');
    this.term.write(`\x1b[H\x1b[2J${body}\x1b[0m\x1b[${cap.cursorY + 1};${cap.cursorX + 1}H`);
  }

  write(data: Uint8Array) {
    this.term.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols !== this.cols || rows !== this.rows) this.term.resize(cols, rows);
  }

  /** ANSI snapshot of the visible screen that a fresh xterm.js can render as-is. */
  snapshot(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  /** Writes are async in xterm; resolve once everything written so far is parsed. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    }
    return out;
  }

  /**
   * Whether Claude Code's input box holds text the user typed (or that an interrupt put back).
   * Placeholders and history suggestions are drawn dim, so only non-dim text counts.
   */
  hasPromptInput(): boolean {
    const buf = this.term.buffer.active;
    for (let y = this.term.rows - 1; y >= Math.max(0, this.term.rows - 16); y--) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line || !/^[❯>]\s/.test(line.translateToString(true))) continue;
      for (let x = 1; x < line.length; x++) {
        const cell = line.getCell(x);
        const ch = cell?.getChars();
        if (cell && ch && ch.trim()) return !cell.isDim();
      }
      return false;
    }
    return false;
  }

  /** Classify the agent's state and pull out the text it is producing right now. */
  analyze(): { status: AgentStatus; preview: string; mode: string; update: boolean } {
    const lines = this.lines().filter((l) => !NOISE.some((re) => re.test(l)));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = lines.join('\n');
    // Claude Code's footer shows the live permission mode ("⏵⏵ auto mode on", "⏸ plan mode on", ...)
    const footer = lines.slice(-4).join('\n');
    const mode = MODES.find(([re]) => re.test(footer))?.[1] ?? '';
    // "✔ Update installed · Restart to update" in the footer: a new version is waiting
    // (shown just above the input box, so look a bit higher than the footer)
    const update = /(Update installed|·)\s*·?\s*Restart to (update|apply)/i.test(lines.slice(-8).join('\n'));
    const waiting = WAITING.some((re) => re.test(text));
    const status: AgentStatus = waiting ? 'waiting' : BUSY.test(text) ? 'busy' : 'idle';

    let end = lines.length;
    if (!waiting) {
      // drop the input box at the bottom: find the prompt line, then cut at the frame above it
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
        if (PROMPT_LINE.test(lines[i])) {
          end = i;
          break;
        }
      }
    }
    // start after the last echoed user prompt (and its continuation lines) so only the current turn shows
    let begin = 0;
    if (!waiting) {
      for (let i = end - 1; i >= 0; i--) {
        if (PROMPT_LINE.test(lines[i])) {
          begin = i + 1;
          while (begin < end && lines[begin].trim()) begin++;
          break;
        }
      }
    }
    const kept: string[] = [];
    for (const raw of lines.slice(begin, end)) {
      if (SEPARATOR.test(raw) || BOX_EDGE.test(raw)) {
        kept.push('');
        continue;
      }
      kept.push(raw.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, ''));
    }
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    const tail = kept.slice(-20);
    while (tail.length && !tail[0].trim()) tail.shift();
    return { status, preview: tail.join('\n'), mode, update };
  }

  dispose() {
    this.term.dispose();
  }
}
