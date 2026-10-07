import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { useHosts } from './dialogs';
import { size } from './files-view';
import { store } from './lib';
import { Modal } from './ui';

// 服务器资源: CPU, memory, GPUs, disks and the busiest processes of a host. Fetched while the
// panel is open (every few seconds, and not while the page is hidden), never in the background.

interface HostStats {
  at: number;
  hostname: string;
  uptime: number;
  cpu: { usage: number; cores: number; load: [number, number, number] };
  mem: { total: number; available: number; swapTotal: number; swapFree: number };
  gpus: { index: number; name: string; util: number; memUsed: number; memTotal: number; temp: number }[];
  disks: { mount: string; size: number; used: number; avail: number }[];
  procs: { pid: number; cpu: number; mem: number; rss: number; name: string; user?: string }[];
}

const EVERY_MS = 3000;

function Bar({ label, pct, text }: { label: string; pct: number; text: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const level = p >= 90 ? 'hi' : p >= 70 ? 'mid' : 'lo';
  return (
    <div class="st-bar">
      <div class="st-bar-top">
        <span>{label}</span>
        <span class="dim">{text}</span>
      </div>
      <div class="st-meter">
        <span class={`st-fill ${level}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

const pctOf = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} 天` : s >= 3600 ? `${Math.floor(s / 3600)} 小时` : `${Math.floor(s / 60)} 分钟`);
const gpuName = (n: string) => n.replace(/^NVIDIA\s+/, '').replace(/^GeForce\s+/, '');

export function StatsModal({ onClose }: { onClose: () => void }) {
  const [hosts] = useHosts();
  const [hostId, setHostId] = useState<number | null>(() => Number(store.get('tw:stats:host')) || null);
  const [st, setSt] = useState<HostStats | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (hosts?.length && !hosts.some((h) => h.id === hostId)) setHostId((hosts.find((h) => h.ok) ?? hosts[0]).id);
  }, [hosts]);

  useEffect(() => {
    if (hostId === null) return;
    let off = false;
    let timer: ReturnType<typeof setTimeout>;
    setSt(null);
    const tick = async () => {
      if (off) return;
      if (!document.hidden) {
        setBusy(true);
        try {
          const s = await api<HostStats>('GET', `/_tw/api/hosts/${hostId}/stats`);
          if (!off) (setSt(s), setErr(''));
        } catch (e: any) {
          if (!off) setErr(e.message);
        } finally {
          if (!off) setBusy(false);
        }
      }
      if (!off) timer = setTimeout(tick, EVERY_MS);
    };
    void tick();
    return () => {
      off = true;
      clearTimeout(timer);
    };
  }, [hostId]);

  const host = hosts?.find((h) => h.id === hostId);
  const memUsed = st ? st.mem.total - st.mem.available : 0;
  return (
    <Modal title="服务器资源" class="stats" onClose={onClose}>
      <div class="st-head">
        {hosts && hosts.length > 1 ? (
          <select
            value={hostId ?? ''}
            onChange={(e) => {
              const id = Number((e.target as HTMLSelectElement).value);
              setHostId(id);
              store.set('tw:stats:host', String(id));
            }}
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        ) : (
          <b>{host?.name ?? ''}</b>
        )}
        <span class="dim small">{st ? `${st.hostname} · 已运行 ${uptime(st.uptime)}` : ''}</span>
        <span class={`st-live ${busy ? 'on' : ''}`} title={`每 ${EVERY_MS / 1000} 秒刷新`} />
      </div>
      {err && <p class="error small">{err}</p>}
      {!st && !err && <p class="dim small pad">读取中…</p>}
      {st && (
        <div class="st-body">
          <section>
            <Bar label={`CPU · ${st.cpu.cores} 核`} pct={st.cpu.usage} text={`${st.cpu.usage.toFixed(0)}% · 负载 ${st.cpu.load.map((l) => l.toFixed(2)).join(' ')}`} />
            <Bar label="内存" pct={pctOf(memUsed, st.mem.total)} text={`${size(memUsed)} / ${size(st.mem.total)}`} />
            {st.mem.swapTotal > 0 && (
              <Bar label="交换" pct={pctOf(st.mem.swapTotal - st.mem.swapFree, st.mem.swapTotal)} text={`${size(st.mem.swapTotal - st.mem.swapFree)} / ${size(st.mem.swapTotal)}`} />
            )}
          </section>
          {st.gpus.length > 0 && (
            <section>
              <h3>显卡</h3>
              {st.gpus.map((g) => (
                <div class="st-gpu" key={g.index}>
                  <div class="st-gpu-name">
                    GPU{g.index} · {gpuName(g.name)}
                    <span class="dim"> · {g.temp}°C</span>
                  </div>
                  <div class="st-gpu-bars">
                    <Bar label="使用率" pct={g.util} text={`${g.util}%`} />
                    <Bar label="显存" pct={pctOf(g.memUsed, g.memTotal)} text={`${size(g.memUsed)} / ${size(g.memTotal)}`} />
                  </div>
                </div>
              ))}
            </section>
          )}
          {st.disks.length > 0 && (
            <section>
              <h3>存储</h3>
              {st.disks.map((d) => (
                <Bar key={d.mount} label={d.mount} pct={pctOf(d.used, d.size)} text={`${size(d.used)} / ${size(d.size)} · 剩 ${size(d.avail)}`} />
              ))}
            </section>
          )}
          {st.procs.length > 0 && (
            <section>
              <h3>占用最高的进程</h3>
              <table class="st-procs">
                <tbody>
                  {st.procs.slice(0, 6).map((p) => (
                    <tr key={p.pid}>
                      <td class="st-pname" title={`PID ${p.pid}${p.user ? ` · ${p.user}` : ''}`}>
                        {p.name}
                        {p.user && <span class="dim"> {p.user}</span>}
                      </td>
                      <td>{p.cpu.toFixed(0)}%</td>
                      <td class="dim">{size(p.rss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
