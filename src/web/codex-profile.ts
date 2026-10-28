// The launch args field is still free text. These helpers keep the profile picker in sync with
// `--profile <name>` / `-p <name>` in that field instead of keeping a second, conflicting value.

const PROFILE = /(^|\s)(?:--profile(?:=|\s+)|-p(?:=|\s+))(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+))/g;

/** The profile selected in an args string, or '' for Codex's base config. */
export function codexProfileOf(args: string): string {
  let profile = '';
  for (const m of args.matchAll(PROFILE)) profile = m[2] ?? m[3] ?? m[4] ?? '';
  return profile.replace(/\\(["'\\$`])/g, '$1');
}

/** Replace (or remove, with '') the profile option while leaving every other launch arg alone. */
export function setCodexProfile(args: string, profile: string): string {
  const base = args
    .replace(PROFILE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return profile ? `${base}${base ? ' ' : ''}--profile ${profile}` : base;
}
