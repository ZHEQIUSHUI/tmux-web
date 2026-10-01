import { EventEmitter } from 'node:events';
import type { PaneCapture, PaneStream, PaneTarget, SessionBackend } from './types.js';

/**
 * tmux on the session's host. Our sessions live on their own socket (-L) with no config file
 * (-f /dev/null), so the user's own tmux sessions and ~/.tmux.conf are untouched; -u forces
 * UTF-8 even when the remote shell has no locale.
 */
const tmux = (socket: string, ...args: string[]) => ['tmux', '-u', '-L', socket, '-f', '/dev/null', ...args];

async function run(t: PaneTarget, args: string[], input?: string | Buffer): Promise<string> {
  try {
    return (await t.host.exec(tmux(t.socket, ...args), input)).toString('utf8');
  } catch (e: any) {
    e.message = `tmux ${args[0]}: ${e.message}`;
    throw e;
  }
}

/** Target the session's first pane. `=` makes tmux match the session name exactly. */
const target = (t: PaneTarget) => `=${t.name}:`;

/** Decode a %output payload: tmux escapes bytes < 0x20 and backslash as \ooo octal. */
function decodeOutput(buf: Buffer, start: number): Buffer {
  const out = Buffer.allocUnsafe(buf.length - start);
  let n = 0;
  for (let i = start; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && i + 3 < buf.length) {
      const d1 = buf[i + 1] - 48;
      const d2 = buf[i + 2] - 48;
      const d3 = buf[i + 3] - 48;
      if (d1 >= 0 && d1 < 8 && d2 >= 0 && d2 < 8 && d3 >= 0 && d3 < 8) {
        out[n++] = d1 * 64 + d2 * 8 + d3;
        i += 3;
        continue;
      }
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

const OUTPUT_PREFIX = Buffer.from('%output ');

/**
 * A tmux control-mode client (`tmux -C attach`) running on the host. It gets every byte the pane
 * prints as a %output notification, without polling, and accepts commands on stdin for input and
 * resizing. Over SSH this is the same thing iTerm2's tmux integration does.
 */
class ControlStream extends EventEmitter implements PaneStream {
  private child;
  private pending: Buffer[] = [];
  private closed = false;

  constructor(private t: PaneTarget) {
    super();
    this.child = t.host.spawn(tmux(t.socket, '-C', 'attach-session', '-t', `=${t.name}`));
    this.child.stdout.on('data', (chunk: Buffer) => this.onChunk(chunk));
    this.child.stderr.resume();
    this.child.on('close', () => this.finish());
    this.child.on('error', () => this.finish());
    this.child.stdin.on('error', () => {});
  }

  private onChunk(chunk: Buffer) {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, i);
      const line = this.pending.length ? Buffer.concat([...this.pending, piece]) : piece;
      this.pending = [];
      this.onLine(line);
      start = i + 1;
    }
    if (start < chunk.length) this.pending.push(Buffer.from(chunk.subarray(start)));
  }

  private onLine(line: Buffer) {
    if (line.subarray(0, OUTPUT_PREFIX.length).equals(OUTPUT_PREFIX)) {
      // %output %<pane-id> <data>
      const sp = line.indexOf(0x20, OUTPUT_PREFIX.length);
      if (sp !== -1) this.emit('data', decodeOutput(line, sp + 1));
    } else if (line.subarray(0, 5).toString() === '%exit') {
      this.finish();
    } else if (line.subarray(0, 14).toString() === '%layout-change') {
      this.emit('layout');
    }
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    this.emit('exit');
  }

  private command(cmd: string) {
    if (!this.closed) this.child.stdin.write(cmd + '\n');
  }

  write(data: string | Buffer) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // send-keys -H takes hex bytes, which sidesteps every quoting issue of control-mode commands
    for (let i = 0; i < bytes.length; i += 512) {
      const hex = Array.from(bytes.subarray(i, i + 512), (b) => b.toString(16).padStart(2, '0')).join(' ');
      this.command(`send-keys -t ${target(this.t)} -H ${hex}`);
    }
  }

  resize(cols: number, rows: number) {
    this.command(`resize-window -t ${target(this.t)} -x ${cols} -y ${rows}`);
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end(); // closing stdin detaches the control client
    this.finish();
  }
}

export class TmuxBackend implements SessionBackend {
  async has(t: PaneTarget) {
    try {
      await run(t, ['has-session', '-t', `=${t.name}`]);
      return true;
    } catch (e: any) {
      if (e.ssh) throw e; // host unreachable: we don't know
      return false;
    }
  }

  async create(t: PaneTarget, o: { cwd: string; command: string; cols: number; rows: number; term: string }) {
    // one invocation: server options first (history-limit only applies to panes created after it),
    // then the session, then pin its size so attached control clients don't shrink it
    // prettier-ignore
    await run(t, [
      'start-server', ';',
      'set-option', '-s', 'escape-time', '10', ';',
      'set-option', '-s', 'focus-events', 'on', ';',
      'set-option', '-g', 'default-shell', '/bin/bash', ';',
      'set-option', '-g', 'default-terminal', o.term, ';',
      'set-option', '-g', 'history-limit', '50000', ';',
      'set-option', '-g', 'status', 'off', ';',
      'set-option', '-g', 'mouse', 'off', ';',
      'new-session', '-d', '-s', t.name, '-x', String(o.cols), '-y', String(o.rows), '-c', o.cwd, o.command, ';',
      'set-option', '-w', '-t', target(t), 'window-size', 'manual',
    ]);
  }

  async kill(t: PaneTarget) {
    await run(t, ['kill-session', '-t', `=${t.name}`]).catch(() => {});
  }

  async paste(t: PaneTarget, text: string) {
    const buf = `tw-in-${process.pid}-${Date.now()}`;
    await run(t, ['load-buffer', '-b', buf, '-', ';', 'paste-buffer', '-p', '-d', '-b', buf, '-t', target(t)], text);
  }

  async keys(t: PaneTarget, keys: string[]) {
    await run(t, ['send-keys', '-t', target(t), ...keys]);
  }

  async capture(t: PaneTarget): Promise<PaneCapture> {
    const SEP = '\u001fTW\u001f';
    const out = await run(t, ['display-message', '-p', '-t', target(t), `#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}${SEP}`, ';', 'capture-pane', '-p', '-e', '-t', target(t)]);
    const i = out.indexOf(SEP);
    const [cols, rows, cursorX, cursorY] = out.slice(0, i).trim().split(' ').map(Number);
    return { text: out.slice(i + SEP.length + 1), cols, rows, cursorX, cursorY };
  }

  stream(t: PaneTarget): PaneStream {
    return new ControlStream(t);
  }
}
