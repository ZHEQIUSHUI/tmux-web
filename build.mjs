// Builds the server bundle (dist/server.js) and the web app (dist/web), with precompressed assets.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const watch = process.argv.includes('--watch');
const out = 'dist';
const webOut = path.join(out, 'web');

const serverOptions = {
  entryPoints: ['src/server/index.ts'],
  outfile: path.join(out, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

const webOptions = {
  entryPoints: { main: 'src/web/main.tsx' },
  outdir: path.join(webOut, '_tw', 'assets'),
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['chrome100', 'safari15', 'firefox100'],
  minify: !watch,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  entryNames: '[name]-[hash]',
  chunkNames: '[name]-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'info',
  legalComments: 'none',
};

function writeHtml(meta) {
  const [js, entry] = Object.entries(meta.outputs).find(([, o]) => o.entryPoint === 'src/web/main.tsx');
  const css = entry.cssBundle;
  const rel = (f) => '/' + path.relative(webOut, f).split(path.sep).join('/');
  let html = fs.readFileSync('src/web/index.html', 'utf8');
  html = html.replace('<!--CSS-->', css ? `<link rel="stylesheet" href="${rel(css)}" />` : '');
  html = html.replace('<!--JS-->', `<script type="module" src="${rel(js)}"></script>`);
  fs.writeFileSync(path.join(webOut, 'index.html'), html);
}

function compressAll(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) compressAll(p);
    else if (/\.(js|css|html|svg|json)$/.test(ent.name)) {
      const raw = fs.readFileSync(p);
      fs.writeFileSync(p + '.gz', zlib.gzipSync(raw, { level: 9 }));
      fs.writeFileSync(p + '.br', zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
    }
  }
}

function report() {
  const rows = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(ent.name) && fs.existsSync(p + '.br'))
        rows.push(`${path.relative(webOut, p).padEnd(40)} ${(fs.statSync(p).size / 1024).toFixed(1).padStart(7)} KB  br ${(fs.statSync(p + '.br').size / 1024).toFixed(1).padStart(6)} KB`);
    }
  };
  walk(webOut);
  console.log(rows.join('\n'));
}

// Keep earlier hashed assets for a while: pages opened before a rebuild still load their lazy
// chunks (the terminal) by the old names. Everything else is rebuilt from scratch.
const assetsDir = path.join(webOut, '_tw', 'assets');
const KEEP_MS = 7 * 24 * 3600 * 1000;
for (const ent of fs.existsSync(webOut) ? fs.readdirSync(webOut) : []) {
  if (ent !== '_tw') fs.rmSync(path.join(webOut, ent), { recursive: true, force: true });
}
for (const ent of fs.existsSync(path.join(webOut, '_tw')) ? fs.readdirSync(path.join(webOut, '_tw')) : []) {
  if (ent !== 'assets') fs.rmSync(path.join(webOut, '_tw', ent), { recursive: true, force: true });
}
for (const ent of fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []) {
  const p = path.join(assetsDir, ent);
  if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true });
}
fs.mkdirSync(webOut, { recursive: true });
// icons + manifest. Everything of ours lives under /_tw/ so proxied apps can use any other path.
fs.cpSync('src/web/public', path.join(webOut, '_tw'), { recursive: true });

if (watch) {
  const webPlugin = {
    name: 'html',
    setup(build) {
      build.onEnd((r) => r.metafile && writeHtml(r.metafile));
    },
  };
  const s = await esbuild.context(serverOptions);
  const w = await esbuild.context({ ...webOptions, plugins: [webPlugin] });
  await Promise.all([s.watch(), w.watch()]);
} else {
  await esbuild.build(serverOptions);
  const r = await esbuild.build(webOptions);
  writeHtml(r.metafile);
  compressAll(webOut);
  report();
}
