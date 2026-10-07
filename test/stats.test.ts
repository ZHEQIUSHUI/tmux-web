import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStats } from '../src/server/stats.js';

test('host stats: cpu from two /proc/stat samples, memory, GPUs, disks, top processes', () => {
  const out = [
    'CPU1 cpu  100 0 100 800 0 0 0 0 0 0',
    'CPU2 cpu  150 0 150 900 0 0 0 0 0 0',
    'NPROC 64',
    'LOAD 0.97 0.64 0.54 2/1234 99',
    'UPTIME 27301234.5',
    'HOST box',
    'MEM MemTotal:       131000000 kB',
    'MEM MemAvailable:   102000000 kB',
    'MEM SwapTotal:      0 kB',
    'GPU 0, NVIDIA GeForce RTX 3090, 37, 1200, 24576, 45',
    'DF /dev/nvme0n1p2 918491060 608652896 263107720 70% /',
    'DF /dev/nvme0n1p1 523248 6220 517028 2% /boot/efi',
    'DF /dev/sdb1 3844640564 1000 3844639564 1% /mnt/my disk',
    'TOP 2575999 qiushui   20   0 5675136 498180 139136 R  15.1   0.4  25:40.12 claude',
    'TOP 1170757 qiushui   20   0   10.3g 1.5g  20976 S   3.8   0.2   1604:03 claude code',
  ].join('\n');
  const st = parseStats(out);
  assert.equal(Math.round(st.cpu.usage), 50); // 100 busy of 200 ticks
  assert.equal(st.cpu.cores, 64);
  assert.deepEqual(st.cpu.load, [0.97, 0.64, 0.54]);
  assert.equal(st.mem.total, 131000000 * 1024);
  assert.equal(st.gpus[0].util, 37);
  assert.equal(st.gpus[0].memTotal, 24576 * 1024 * 1024);
  assert.deepEqual(st.disks.map((d) => d.mount), ['/', '/mnt/my disk']);
  assert.equal(st.procs[0].rss, 498180 * 1024);
  assert.equal(st.procs[1].rss, 1.5 * 1024 ** 3);
  assert.equal(st.procs[1].name, 'claude code');
});
