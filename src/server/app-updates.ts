import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// The Mac and Android apps check for updates here, through the SSH forward they already have:
// GitHub may be slow or unreachable from a phone, the server usually gets there fine. version.json
// of the latest release is cached for a while; the files themselves on disk (by checksum).
//
// A server in mainland China may not get to GitHub well either, so the release is fetched from
// several places at once and the quickest wins: GitHub, GitHub's download proxies there, and the
// same files in GitHub's container registry (GHCR) through Nanjing University's mirror. Files are
// checked against version.json's SHA-256, whoever served them.

const RELEASE = 'https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/';
/** download proxies for github.com in mainland China: prefixed to the github.com address */
export const GH_PROXIES = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://gh.llkk.cc/', 'https://ghproxy.net/'];
/** the release as an OCI artifact (CI pushes it): version.json in the manifest, the files as blobs */
const IMAGE = 'zheqiushui/tmux-web-app';
const GHCR_HOSTS = ['ghcr.nju.edu.cn', 'ghcr.io'];
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

let token: { at: number; value: string } | null = null;
/** GHCR's anonymous pull token (public package), good for a few minutes */
async function ghcrToken(): Promise<string> {
  if (token && Date.now() - token.at < 4 * 60_000) return token.value;
  const r = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${IMAGE}:pull`, { signal: AbortSignal.timeout(10_000) });
  const value = ((await r.json()) as { token?: string }).token;
  if (!r.ok || !value) throw new Error(`GHCR token ${r.status}`);
  token = { at: Date.now(), value };
  return value;
}

/** "2026.10.9.12" > "2026.10.9.9" */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function valid(v: unknown): VersionInfo {
  const info = v as VersionInfo;
  if (!info || typeof info.version !== 'string' || !(info.mac || info.android)) throw new Error('version.json 不对');
  return info;
}

async function fromGithub(url: string, signal: AbortSignal): Promise<VersionInfo> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${r.status}`);
  return valid(await r.json());
}

async function fromGhcr(host: string, signal: AbortSignal): Promise<VersionInfo> {
  const r = await fetch(`https://${host}/v2/${IMAGE}/manifests/latest`, {
    signal,
    headers: { Authorization: `Bearer ${await ghcrToken()}`, Accept: 'application/vnd.oci.image.manifest.v1+json' },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  const m = (await r.json()) as { annotations?: Record<string, string> };
  return valid(JSON.parse(m.annotations?.['tw.version'] || 'null'));
}

/**
 * version.json from everywhere at once. The first answer wins, unless another one arriving just
 * after it is newer (a proxy may still have the previous one cached).
 */
async function fetchVersion(): Promise<VersionInfo> {
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(20_000)]);
  const tries = [
    fromGithub(RELEASE + 'version.json', signal),
    ...GH_PROXIES.map((p) => fromGithub(p + RELEASE + 'version.json', signal)),
    ...GHCR_HOSTS.map((h) => fromGhcr(h, signal)),
  ];
  return new Promise((resolve, reject) => {
    let best: VersionInfo | null = null;
    let left = tries.length;
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      stop.abort();
      best ? resolve(best) : reject(new Error('GitHub 和镜像都取不到版本信息'));
    };
    for (const t of tries)
      t.then(
        (info) => {
          if (!best || newer(info.version, best.version)) best = info;
          timer ??= setTimeout(done, 1500);
        },
        () => {},
      ).finally(() => {
        if (--left === 0) done();
      });
  });
}

let cached: { at: number; info: VersionInfo } | null = null;

export async function latestVersion(): Promise<VersionInfo> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.info;
  try {
    const info = await fetchVersion();
    cached = { at: Date.now(), info };
    return info;
  } catch (e) {
    if (cached) return cached.info; // a hiccup: what we knew
    throw e;
  }
}

interface Source {
  url: string;
  headers?: Record<string, string>;
}

/** The places that have this file, quickest-to-try first doesn't matter: they race. */
async function sources(name: string, sha?: string): Promise<Source[]> {
  const list: Source[] = [{ url: RELEASE + name }, ...GH_PROXIES.map((p) => ({ url: p + RELEASE + name }))];
  if (sha) {
    const t = await ghcrToken().catch(() => null);
    if (t) for (const h of GHCR_HOSTS) list.push({ url: `https://${h}/v2/${IMAGE}/blobs/sha256:${sha}`, headers: { Authorization: `Bearer ${t}` } });
  }
  return list;
}

/**
 * All sources start; the first to deliver half a megabyte (or the whole file) is the quick one and
 * carries on, the others are dropped. If it then fails or the file is wrong, the rest race again.
 */
export async function raceDownload(list: Source[], sha?: string, head = 512 * 1024): Promise<Buffer> {
  if (!list.length) throw new Error('GitHub 和镜像都下载失败');
  let winner: number | null = null;
  const stops = list.map(() => new AbortController());
  const one = async (s: Source, i: number): Promise<Buffer> => {
    const r = await fetch(s.url, { headers: s.headers, signal: AbortSignal.any([stops[i].signal, AbortSignal.timeout(300_000)]) });
    if (!r.ok || !r.body) throw new Error(`${r.status}`);
    const parts: Uint8Array[] = [];
    let got = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      parts.push(chunk);
      got += chunk.length;
      if (winner === null && got >= head) claim(i);
      if (winner !== null && winner !== i) throw new Error('slower');
    }
    if (winner === null) claim(i);
    if (winner !== i) throw new Error('slower');
    const data = Buffer.concat(parts);
    if (sha && crypto.createHash('sha256').update(data).digest('hex') !== sha) throw new Error('checksum');
    return data;
  };
  const claim = (i: number) => {
    winner = i;
    stops.forEach((c, j) => j !== i && c.abort());
  };
  const runs = list.map((s, i) => one(s, i));
  // wait for the winner (or for every one to fail before anyone won)
  const settled = await new Promise<{ i: number; data?: Buffer }>((resolve) => {
    let left = runs.length;
    runs.forEach((p, i) =>
      p.then(
        (data) => resolve({ i, data }),
        () => {
          if (winner === i) resolve({ i });
          else if (--left === 0) resolve({ i: -1 });
        },
      ),
    );
  });
  if (settled.data) return settled.data;
  // the quick one failed: the others again (the ones that failed on their own go too)
  if (settled.i < 0) throw new Error('GitHub 和镜像都下载失败');
  return raceDownload(
    list.filter((_, j) => j !== settled.i),
    sha,
    head,
  );
}

/** A file of the latest release (only those version.json names), downloaded once and kept. */
export async function releaseFile(name: string): Promise<{ path: string; size: number }> {
  const info = await latestVersion();
  const entry = [info.mac, info.android].find((f) => f?.file === name);
  if (!entry) throw Object.assign(new Error('没有这个文件'), { status: 404 });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.sha256 || info.version}-${name}`);
  if (!fs.existsSync(file)) {
    const data = await raceDownload(await sources(name, entry.sha256), entry.sha256);
    fs.writeFileSync(file + '.part', data);
    fs.renameSync(file + '.part', file);
    // older versions of this file go
    for (const f of fs.readdirSync(dir)) if (f.endsWith(`-${name}`) && path.join(dir, f) !== file) fs.rmSync(path.join(dir, f), { force: true });
  }
  return { path: file, size: fs.statSync(file).size };
}
