// Bundles test/*.test.ts with esbuild and runs them with node's built-in test runner.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = '.test-out';
fs.rmSync(out, { recursive: true, force: true });
const entries = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => path.join('test', f));
await esbuild.build({ entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const r = spawnSync(process.execPath, ['--test', ...fs.readdirSync(out).map((f) => path.join(out, f))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
