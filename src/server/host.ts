import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { q, type HostRow } from './db.js';

/** Quote one argument for a POSIX shell (also fine for bash/zsh/fish). */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- ssh identity ----------

const sshDir = path.join(config.dataDir, 'ssh');
const keyFile = path.join(sshDir, 'id_ed25519');
const knownHosts = path.join(sshDir, 'known_hosts');

/** Key pair the server uses to log into hosts; generated once and kept in the data volume. */
export function ensureSshKey(): string {
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'tmux-web', '-f', keyFile]);
  }
  fs.chmodSync(keyFile, 0o600);
  return fs.readFileSync(keyFile + '.pub', 'utf8').trim();
}

export function publicKey(): string | null {
  try {
    return fs.readFileSync(keyFile + '.pub', 'utf8').trim();
  } catch {
    return null;
  }
}

// ---------- hosts ----------

export interface HostStatus {
  ok: boolean;
  checkedAt: number;
  error?: string;
  tmux?: string;
  home?: string;
  term?: string;
}

/** Limits concurrent short commands: sshd allows only ~10 sessions per multiplexed connection. */
class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * A machine sessions run on. Everything — tmux, mkdir, reading agent logs — goes through
 * exec()/spawn(), so a local host and a remote one behave the same.
 */
export class Host {
  status: HostStatus = { ok: false, checkedAt: 0 };
  private gate = new Semaphore(6);
  private checking: Promise<HostStatus> | null = null;

  constructor(public row: HostRow) {}

  get label() {
    return this.row.kind === 'local' ? this.row.name : `${this.row.ssh_user}@${this.row.address}:${this.row.port}`;
  }

  private sshArgs(multiplex: boolean): string[] {
    const r = this.row;
    return [
      '-i', keyFile,
      '-p', String(r.port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'LogLevel=ERROR',
      ...(multiplex
        ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/tw-ssh-%C`, '-o', 'ControlPersist=600']
        : ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']),
      '-T',
      `${r.ssh_user}@${r.address}`,
    ];
  }

  /**
   * Start a long-running command (control-mode client, tail -F). Gets its own SSH connection so
   * many of them don't run into the per-connection session limit of the multiplexed one.
   */
  spawn(argv: string[]): ChildProcessWithoutNullStreams {
    if (this.row.kind === 'local') {
      const env = { ...process.env };
      delete env.TMUX;
      return spawn(argv[0], argv.slice(1), { env, stdio: 'pipe' });
    }
    return spawn('ssh', [...this.sshArgs(false), argv.map(shq).join(' ')], { stdio: 'pipe' });
  }

  /** Run a short command and collect stdout. */
  exec(argv: string[], input?: string | Buffer, timeoutMs = 20000): Promise<Buffer> {
    return this.gate.run(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          const child =
            this.row.kind === 'local'
              ? spawn(argv[0], argv.slice(1), { env: { ...process.env, TMUX: '' }, stdio: 'pipe' })
              : spawn('ssh', [...this.sshArgs(true), argv.map(shq).join(' ')], { stdio: 'pipe' });
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          const timer = setTimeout(() => child.kill(), timeoutMs);
          child.stdout.on('data', (b) => out.push(b));
          child.stderr.on('data', (b) => err.push(b));
          child.stdin.on('error', () => {});
          child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) return resolve(Buffer.concat(out));
            const msg = Buffer.concat(err).toString().trim() || `exit ${code}`;
            const e = new Error(msg) as Error & { code?: number; ssh?: boolean };
            e.code = code ?? -1;
            // ssh itself failed (could not connect / authenticate), as opposed to the remote command
            e.ssh = this.row.kind === 'ssh' && code === 255;
            if (e.ssh) this.markDown(msg);
            reject(e);
          });
          child.stdin.end(input);
        }),
    );
  }

  /** Run a POSIX sh script with positional arguments. */
  sh(script: string, args: string[] = [], input?: string | Buffer): Promise<Buffer> {
    return this.exec(['sh', '-c', script, 'sh', ...args], input);
  }

  async shText(script: string, args: string[] = []): Promise<string> {
    return (await this.sh(script, args)).toString('utf8');
  }

  private markDown(error: string) {
    this.status = { ok: false, checkedAt: Date.now(), error };
  }

  /** Probe the host: reachable, tmux installed, home dir, best TERM for panes. */
  check(): Promise<HostStatus> {
    this.checking ??= (async () => {
      try {
        const out = await this.shText(
          `printf '%s\\n' "$HOME"; tmux -V 2>/dev/null || echo; ` + `if infocmp tmux-256color >/dev/null 2>&1; then echo tmux-256color; else echo screen-256color; fi`,
        );
        const [home, tmux, term] = out.split('\n');
        this.status = tmux
          ? { ok: true, checkedAt: Date.now(), home, tmux, term }
          : { ok: false, checkedAt: Date.now(), home, error: '主机上没有安装 tmux' };
      } catch (e: any) {
        this.status = { ok: false, checkedAt: Date.now(), error: e.message };
      }
      return this.status;
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /** Status if fresh, otherwise re-checked. */
  async ready(): Promise<HostStatus> {
    if (this.status.ok && Date.now() - this.status.checkedAt < 5 * 60 * 1000) return this.status;
    return this.check();
  }

  // ---------- ports (web apps agents start on the host) ----------

  private forwards = new Map<number, Promise<number>>();

  /**
   * A local TCP port that reaches 127.0.0.1:<port> on the host. Local hosts: the port itself.
   * SSH hosts: a forward added to the multiplexed connection (ssh -O forward), so every proxied
   * request rides the existing SSH connection.
   */
  forward(port: number): Promise<number> {
    if (this.row.kind === 'local') return Promise.resolve(port);
    let f = this.forwards.get(port);
    if (!f) {
      f = this.addForward(port);
      f.catch(() => this.forwards.delete(port));
      this.forwards.set(port, f);
    }
    return f;
  }

  /** Forget a forward that stopped working (the master connection went away); next use re-adds it. */
  dropForward(port: number) {
    this.forwards.delete(port);
  }

  private async addForward(port: number): Promise<number> {
    await this.exec(['true']); // make sure the multiplexing master is up
    const local = await freePort();
    const args = this.sshArgs(true);
    const dest = args.pop()!;
    args.pop(); // -T
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', [...args, '-O', 'forward', '-L', `127.0.0.1:${local}:127.0.0.1:${port}`, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
      const err: Buffer[] = [];
      child.stderr.on('data', (b) => err.push(b));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString().trim() || `ssh -O forward: exit ${code}`))));
    });
    return local;
  }

  /** TCP ports listening on the host, with the owning process when visible to the SSH user. */
  async listPorts(): Promise<{ port: number; addr: string; proc?: string }[]> {
    const out = await this.shText('ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null || true');
    const seen = new Map<number, { port: number; addr: string; proc?: string }>();
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[3];
      const i = local.lastIndexOf(':');
      const port = Number(local.slice(i + 1));
      if (!port || port === 22) continue;
      const proc = /users:\(\("([^"]+)"/.exec(line)?.[1];
      const prev = seen.get(port);
      if (!prev || (!prev.proc && proc)) seen.set(port, { port, addr: local.slice(0, i), proc });
    }
    return [...seen.values()].sort((a, b) => a.port - b.port);
  }

  // ---------- files (agent logs live on the host) ----------

  /** Size of the file plus up to `tail` bytes from its end, in one round trip. */
  async readTail(file: string, tail: number): Promise<{ size: number; data: Buffer }> {
    const out = await this.sh(
      `s=$(wc -c < "$1") || exit 3; o=$(( s > $2 ? s - $2 : 0 )); printf '%s\\n' "$s"; tail -c +$(( o + 1 )) -- "$1" | head -c $(( s - o ))`,
      [file, String(tail)],
    );
    const nl = out.indexOf(0x0a);
    return { size: Number(out.subarray(0, nl).toString()), data: out.subarray(nl + 1) };
  }

  /** Bytes [from, to) of a file. */
  async read(file: string, from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0);
    return this.sh(`tail -c +$(( $2 + 1 )) -- "$1" | head -c $3`, [file, String(from), String(to - from)]);
  }

  /**
   * Stream a file from `offset` on, following appends (tail -F). The remote tail is killed when
   * our end closes stdin, so nothing lingers on the host.
   */
  follow(file: string, offset: number): ChildProcessWithoutNullStreams {
    return this.spawn(['sh', '-c', `tail -c +$(( $2 + 1 )) -F -- "$1" 2>/dev/null & p=$!; read _; kill $p 2>/dev/null`, 'sh', file, String(offset)]);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const hosts = new Map<number, Host>();

export function getHost(id: number): Host | null {
  const row = q.hostById.get(id);
  if (!row) {
    hosts.delete(id);
    return null;
  }
  let h = hosts.get(id);
  if (!h || JSON.stringify(h.row) !== JSON.stringify(row)) {
    h = new Host(row);
    hosts.set(id, h);
  }
  return h;
}

export function forgetHost(id: number) {
  hosts.delete(id);
}
