import type { Host } from './host.js';

/** One limit window: how much of it is used and when it starts over. */
export interface UsageWindow {
  pct: number;
  resetsAt: string | null;
}

/** The plan limits of the Claude account a host is logged in to (what /usage shows). */
export interface ClaudeUsage {
  fiveHour?: UsageWindow;
  week?: UsageWindow;
  weekOpus?: UsageWindow;
  weekSonnet?: UsageWindow;
  /** why there is nothing to show */
  error?: string;
  at: number;
}

// A rough figure is enough: one look per host per half hour at most (and only when a page asks,
// i.e. a Claude session is open there)
const TTL = 30 * 60 * 1000;
const cache = new Map<number, { at: number; p: Promise<ClaudeUsage> }>();

const win = (w: any): UsageWindow | undefined =>
  w && typeof w.utilization === 'number' ? { pct: Math.round(w.utilization), resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null } : undefined;

async function fetchUsage(host: Host): Promise<ClaudeUsage> {
  const at = Date.now();
  // Only read the login Claude Code keeps; it refreshes the token itself. Refreshing it here would
  // replace the refresh token under Claude Code's feet.
  const raw = await host.shText(`cat -- "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null; true`).catch(() => '');
  let oauth: any;
  try {
    oauth = JSON.parse(raw).claudeAiOauth;
  } catch {
    /* no file (macOS keeps it in the keychain) or not logged in */
  }
  if (!oauth?.accessToken) return { at, error: '读不到这台机器上 Claude 的登录信息（macOS 上存在钥匙串里，读不了）' };
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < at) return { at, error: '登录凭据已过期，Claude 下次运行时会自动续上' };
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { at, error: r.status === 429 ? '查询太频繁，稍后再看' : `查询失败（HTTP ${r.status}）` };
    const d: any = await r.json();
    return { at, fiveHour: win(d.five_hour), week: win(d.seven_day), weekOpus: win(d.seven_day_opus), weekSonnet: win(d.seven_day_sonnet) };
  } catch (e: any) {
    return { at, error: `连不上 Anthropic：${e.message}` };
  }
}

export function claudeUsage(host: Host): Promise<ClaudeUsage> {
  const c = cache.get(host.row.id);
  if (c && Date.now() - c.at < TTL) return c.p;
  const p = fetchUsage(host);
  cache.set(host.row.id, { at: Date.now(), p });
  return p;
}
