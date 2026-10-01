import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway directory; modules that open the database read DATA_DIR at import time. */
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
process.env.DATA_DIR ||= path.join(tmp, 'data');

export function writeLines(name: string, lines: unknown[]): string {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
}

/** Claude Code log records, as they appear in ~/.claude/projects/*.jsonl */
export const cc = {
  user: (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, origin: { kind: 'human' }, promptSource: 'typed', ...extra }),
  assistant: (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content }, ...extra }),
};
