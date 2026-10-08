import xtermHeadless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import type { PaneCapture } from './backend/types.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializePkg;

export type AgentStatus = 'starting' | 'idle' | 'busy' | 'waiting' | 'offline' | 'dead';

// "esc to interrupt" in the footer, or — when the window is too narrow for the footer to say
// it — Claude Code's spinner line "✻ Working… (12s · ↓ 1.2k tokens)" (finished: "✻ Crunched for 4s",
// no ellipsis) and Codex's "Working (3s • esc to interrupt)"
// queued messages ("Press up to edit queued messages") only exist while a turn is running
const BUSY = /esc to interrupt|Press up to edit queued messages|^\s*\S?\s*[A-Z][\w-]*…\s*\(\s*\d+[hms]|^\s*\S?\s*Working\s*\(\d+[hms]/im;
// permission prompts / pickers of Claude Code and Codex
const WAITING = [/Do you want to /, /^\s*[❯›>]\s*\d+\.\s/m, /Enter to confirm/, /\(y\/n\)/i, /Press enter to continue/i, /Yes, (allow|proceed)/i];
const MODES: [RegExp, string][] = [
  [/bypass permissions on/i, 'bypassPermissions'],
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
];
const BACKGROUND = /\d+\s+(?:shells?|monitors?|bash(?:es)?|background tasks?)(?:,\s*\d+\s+(?:shells?|monitors?|bash(?:es)?|background tasks?))*/i;
/** A numbered menu the agent shows (permission prompt, AskUserQuestion, submit/cancel...). */
export interface Choices {
  question: string;
  options: { n: number; label: string; selected: boolean }[];
}

const OPTION = /^\s*([❯›>]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/;

/**
 * Read the menu at the bottom of the screen: the numbered options (the highlighted one carries
 * ❯) and the question line above them. Description lines under an option are indented; footer
 * hints below the menu are skipped. Only a run 1..k that contains the highlighted option counts,
 * so numbered lists in the agent's text above are never mistaken for a menu.
 */
export function findChoices(lines: string[]): Choices | null {
  const options: Choices['options'] = [];
  let question = '';
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const l = lines[i].replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '');
    const m = OPTION.exec(l);
    if (m) {
      options.unshift({ n: Number(m[2]), label: m[3].trim(), selected: !!m[1] });
      continue;
    }
    if (!options.length) continue; // hints below the menu
    if (!l.trim() || SEPARATOR.test(l) || /^\s{3,}\S/.test(l)) continue; // option descriptions, rules
    question = l.trim();
    break;
  }
  // the last run starting at 1
  const start = options.map((o) => o.n).lastIndexOf(1);
  const run = start === -1 ? [] : options.slice(start);
  const consecutive = run.every((o, i) => o.n === i + 1);
  if (!run.length || !consecutive || !run.some((o) => o.selected)) return null;
  return { question, options: run };
}

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
    // the input box is just above the footer, which is at the end of the content (not
    // necessarily the bottom of the screen in a short session)
    let last = this.term.rows - 1;
    while (last > 0 && !buf.getLine(buf.viewportY + last)?.translateToString(true).trim()) last--;
    for (let y = last; y >= Math.max(0, last - 15); y--) {
      const line = buf.getLine(buf.viewportY + y);
      const text = line?.translateToString(true) ?? '';
      if (!line || !/^[❯>]\s/.test(text)) continue;
      // only the box itself (right under its top edge): queued messages above it start with ❯ too.
      // "Press up to edit queued messages" in the box is a hint, not typed text.
      const above = buf.getLine(buf.viewportY + y - 1)?.translateToString(true) ?? '';
      if (!SEPARATOR.test(above) || /Press up to edit queued messages/i.test(text)) return false;
      for (let x = 1; x < line.length; x++) {
        const cell = line.getCell(x);
        const ch = cell?.getChars();
        if (cell && ch && ch.trim()) return !cell.isDim();
      }
      return false;
    }
    return false;
  }

  /**
   * Claude Code's UI is up: its input box (❯ under a box line) is on screen, below the line where
   * `launch` was typed if that is still visible (the old UI can linger above it).
   */
  claudeReady(launch = ''): boolean {
    const lines = this.lines();
    let from = 0;
    for (let i = lines.length - 1; launch && i >= 0; i--) {
      if (lines[i].includes(launch)) {
        from = i + 1;
        break;
      }
    }
    return lines.some((l, i) => i >= from && i > 0 && /^❯/.test(l) && SEPARATOR.test(lines[i - 1]));
  }

  /**
   * Claude Code's suggested next message: drawn dim in the empty input box (it sends on Enter).
   * Only when the whole box is dim (nothing typed); the generic 'Try "..."' placeholder isn't one.
   */
  promptSuggestion(): string {
    const buf = this.term.buffer.active;
    let last = this.term.rows - 1;
    while (last > 0 && !buf.getLine(buf.viewportY + last)?.translateToString(true).trim()) last--;
    for (let y = last; y >= Math.max(0, last - 15); y--) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line || !/^[❯>]\s/.test(line.translateToString(true))) continue;
      // the prompt line and any wrapped continuation, up to the box's bottom edge
      const parts: string[] = [];
      for (let yy = y; yy <= last; yy++) {
        const l = buf.getLine(buf.viewportY + yy);
        if (!l) break;
        const s = l.translateToString(true);
        if (yy > y && (/^\s*[─━]{3,}/.test(s) || !s.trim())) break;
        let text = '';
        for (let x = yy === y ? 1 : 0; x < l.length; x++) {
          const cell = l.getCell(x);
          const ch = cell?.getChars() ?? '';
          if (ch.trim() && !cell!.isDim()) return ''; // something typed
          text += ch || (cell?.getWidth() === 0 ? '' : ' ');
        }
        parts.push(text.trim());
      }
      const s = parts.join(' ').trim();
      return /^Try "/.test(s) ? '' : s;
    }
    return '';
  }

  /** Classify the agent's state and pull out the text it is producing right now. */
  analyze(): { status: AgentStatus; preview: string; mode: string; update: boolean; background: string; choices: Choices | null; suggestion: string } {
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
    // background work Claude Code is keeping alive ("1 shell, 1 monitor"); "← 1 agent" is just a hint
    const background = BACKGROUND.exec(footer)?.[0] ?? '';
    return { status, preview: tail.join('\n'), mode, update, background, choices: waiting ? findChoices(lines) : null, suggestion: status === 'idle' ? this.promptSuggestion() : '' };
  }

  dispose() {
    this.term.dispose();
  }
}
