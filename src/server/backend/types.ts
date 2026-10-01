import type { EventEmitter } from 'node:events';
import type { Host } from '../host.js';

/** One terminal session (a single pane) on a host. */
export interface PaneTarget {
  name: string;
  /** tmux server socket name (-L) */
  socket: string;
  host: Host;
}

export interface PaneCapture {
  /** visible screen with SGR escapes, lines separated by \n */
  text: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

/**
 * Live connection to a pane.
 * events: 'data' (Buffer of raw terminal output), 'exit' (), 'layout' (pane size may have changed)
 */
export interface PaneStream extends EventEmitter {
  /** raw input bytes, as a terminal would send them */
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Everything the rest of the server needs from a terminal multiplexer. tmux implements it today;
 * a home-grown PTY daemon could implement it later without touching the layers above.
 */
export interface SessionBackend {
  has(t: PaneTarget): Promise<boolean>;
  create(t: PaneTarget, opts: { cwd: string; command: string; cols: number; rows: number; term: string }): Promise<void>;
  kill(t: PaneTarget): Promise<void>;
  /** paste text as one block (bracketed paste when the app asked for it) */
  paste(t: PaneTarget, text: string): Promise<void>;
  /** named keys, e.g. Enter, Escape, C-c, Up */
  keys(t: PaneTarget, keys: string[]): Promise<void>;
  capture(t: PaneTarget): Promise<PaneCapture>;
  /** live output + input channel; 'exit' also fires when the connection to the host drops */
  stream(t: PaneTarget): PaneStream;
}
