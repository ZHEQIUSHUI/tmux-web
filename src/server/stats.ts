import type { Host } from './host.js';

// A host's resource use for the 服务器资源 panel: one short script per look (Linux /proc, df, ps,
// nvidia-smi when there is one). Polled only while the panel is open.

export interface HostStats {
  at: number;
  hostname: string;
  uptime: number;
  cpu: { usage: number; cores: number; load: [number, number, number] };
  mem: { total: number; available: number; swapTotal: number; swapFree: number };
  gpus: { index: number; name: string; util: number; memUsed: number; memTotal: number; temp: number }[];
  disks: { mount: string; size: number; used: number; avail: number }[];
  procs: { pid: number; cpu: number; mem: number; rss: number; name: string; user?: string }[];
}

const SCRIPT = [
  // top's second frame is the CPU use of the last half second (ps only knows the lifetime average);
  // it also spans the two /proc/stat samples
  `s1=$(head -n1 /proc/stat)`,
  `t=$(top -b -n 2 -d 0.5 -w 512 -o %CPU 2>/dev/null | awk '/^top -/{n++} n==2 && /^ *[0-9]+ /' | head -n 8)`,
  `[ -n "$t" ] || sleep 0.5`,
  `s2=$(head -n1 /proc/stat)`,
  `echo "CPU1 $s1"; echo "CPU2 $s2"`,
  `if [ -n "$t" ]; then printf '%s\n' "$t" | sed 's/^/TOP /'; else ps -eo pid=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 8 | sed 's/^/PS /'; fi`,
  `echo "NPROC $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"`,
  `echo "LOAD $(cat /proc/loadavg)"`,
  `echo "UPTIME $(cut -d' ' -f1 /proc/uptime)"`,
  `echo "HOST $(hostname)"`,
  `grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo | sed 's/^/MEM /'`,
  `command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/GPU /'`,
  `df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x fuse.snapfuse 2>/dev/null | tail -n +2 | sed 's/^/DF /'`,
  `true`,
].join('; ');

const kb = (v: string | undefined) => (Number(v) || 0) * 1024;
/** top's memory columns: KiB, or scaled with a suffix when wide ("10.3g"). */
const topBytes = (v: string) => {
  const m = /^([\d.]+)([kmgtp]?)$/i.exec(v || '');
  return m ? Number(m[1]) * 1024 ** (1 + 'kmgtp'.indexOf(m[2].toLowerCase() || 'k')) : 0;
};

export function parseStats(out: string): HostStats {
  const st: HostStats = {
    at: Date.now(),
    hostname: '',
    uptime: 0,
    cpu: { usage: 0, cores: 0, load: [0, 0, 0] },
    mem: { total: 0, available: 0, swapTotal: 0, swapFree: 0 },
    gpus: [],
    disks: [],
    procs: [],
  };
  const cpu: number[][] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();
    const f = rest.split(/\s+/);
    switch (tag) {
      case 'CPU1':
      case 'CPU2':
        cpu.push(f.slice(1).map(Number));
        break;
      case 'NPROC':
        st.cpu.cores = Number(f[0]) || 0;
        break;
      case 'LOAD':
        st.cpu.load = [Number(f[0]) || 0, Number(f[1]) || 0, Number(f[2]) || 0];
        break;
      case 'UPTIME':
        st.uptime = Number(f[0]) || 0;
        break;
      case 'HOST':
        st.hostname = rest;
        break;
      case 'MEM': {
        const v = kb(f[1]);
        if (f[0] === 'MemTotal:') st.mem.total = v;
        else if (f[0] === 'MemAvailable:') st.mem.available = v;
        else if (f[0] === 'SwapTotal:') st.mem.swapTotal = v;
        else if (f[0] === 'SwapFree:') st.mem.swapFree = v;
        break;
      }
      case 'GPU': {
        const g = rest.split(',').map((x) => x.trim());
        const n = (x: string) => (Number.isFinite(Number(x)) ? Number(x) : 0);
        st.gpus.push({ index: n(g[0]), name: g[1] ?? '', util: n(g[2]), memUsed: n(g[3]) * 1024 * 1024, memTotal: n(g[4]) * 1024 * 1024, temp: n(g[5]) });
        break;
      }
      case 'DF': {
        // Filesystem 1024-blocks Used Available Capacity Mounted-on (the mount may have spaces)
        const mount = f.slice(5).join(' ');
        if (!mount || seen.has(f[0])) break; // the same device mounted twice (bind mounts)
        seen.add(f[0]);
        const size = kb(f[1]);
        // tiny ones and the boot partitions are noise
        if (size < 2 * 1024 ** 3 || /^\/boot(\/|$)/.test(mount)) break;
        st.disks.push({ mount, size, used: kb(f[2]), avail: kb(f[3]) });
        break;
      }
      case 'TOP': {
        // PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND (not our own sampling top)
        if (f.length < 12 || (f[11] === 'top' && f.length === 12)) break;
        st.procs.push({ pid: Number(f[0]), cpu: Number(f[8]) || 0, mem: Number(f[9]) || 0, rss: topBytes(f[5]), name: f.slice(11).join(' '), user: f[1] });
        break;
      }
      case 'PS': {
        const [pid, pcpu, pmem, rss, ...name] = f;
        st.procs.push({ pid: Number(pid), cpu: Number(pcpu) || 0, mem: Number(pmem) || 0, rss: kb(rss), name: name.join(' ') });
        break;
      }
    }
  }
  // /proc/stat: user nice system idle iowait irq softirq steal …; busy = everything but idle+iowait
  if (cpu.length === 2) {
    const total = (a: number[]) => a.slice(0, 8).reduce((s, x) => s + (x || 0), 0);
    const idle = (a: number[]) => (a[3] || 0) + (a[4] || 0);
    const dt = total(cpu[1]) - total(cpu[0]);
    st.cpu.usage = dt > 0 ? Math.max(0, Math.min(100, (1 - (idle(cpu[1]) - idle(cpu[0])) / dt) * 100)) : 0;
  }
  return st;
}

const recent = new Map<number, { at: number; p: Promise<HostStats> }>();

/** The host's stats; a look within the last 2 s is shared (several pages, or quick re-asks). */
export function hostStats(host: Host, hostId: number): Promise<HostStats> {
  const r = recent.get(hostId);
  if (r && Date.now() - r.at < 2000) return r.p;
  const p = host.shText(SCRIPT).then(parseStats);
  recent.set(hostId, { at: Date.now(), p });
  p.catch(() => recent.delete(hostId));
  return p;
}
