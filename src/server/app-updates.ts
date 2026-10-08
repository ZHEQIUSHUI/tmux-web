import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// The Mac and Android apps check for updates here, through the SSH forward they already have:
// GitHub may be slow or unreachable from a phone, the server usually gets there fine. version.json
// of the latest release is cached for a while; the files themselves on disk (by checksum).

const RELEASE = 'https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/';
const FRESH_MS = 10 * 60 * 1000;
const dir = path.join(config.dataDir, 'app-cache');

interface AppFile {
  file: string;
  sha256?: string;
  size?: number;
}
export interface VersionInfo {
  version: string;
  notes?: string;
  mac?: AppFile;
  android?: AppFile & { versionCode?: number };
}

let cached: { at: number; info: VersionInfo } | null = null;

export async function latestVersion(): Promise<VersionInfo> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.info;
  try {
    const r = await fetch(RELEASE + 'version.json', { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const info = (await r.json()) as VersionInfo;
    cached = { at: Date.now(), info };
    return info;
  } catch (e) {
    if (cached) return cached.info; // GitHub hiccup: what we knew
    throw e;
  }
}

/** A file of the latest release (only those version.json names), downloaded once and kept. */
export async function releaseFile(name: string): Promise<{ path: string; size: number }> {
  const info = await latestVersion();
  const entry = [info.mac, info.android].find((f) => f?.file === name);
  if (!entry) throw Object.assign(new Error('没有这个文件'), { status: 404 });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.sha256 || info.version}-${name}`);
  if (!fs.existsSync(file)) {
    const r = await fetch(RELEASE + name, { signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (entry.sha256 && crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error('下载的文件校验不对');
    fs.writeFileSync(file + '.part', data);
    fs.renameSync(file + '.part', file);
    // older versions of this file go
    for (const f of fs.readdirSync(dir)) if (f.endsWith(`-${name}`) && path.join(dir, f) !== file) fs.rmSync(path.join(dir, f), { force: true });
  }
  return { path: file, size: fs.statSync(file).size };
}
