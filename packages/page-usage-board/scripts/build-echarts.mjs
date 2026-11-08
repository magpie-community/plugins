// Reproducible build of the vendored ECharts bundle (custom build: bar/line/pie/heatmap only).
//
//   npm run build:echarts        # rebuild static/echarts.min.js from build/echarts-entry.mjs
//
// CI rebuilds it and compares bytes with the vendored file (git diff --exit-code), so the
// bundle in the package can always be reproduced from the sources in this repo with the
// pinned devDependencies (echarts@5.5.1, esbuild per package-lock.json).
//
// The output must stay byte-identical, so this script IS the build definition:
// - no --global-name: the entry assigns window.echarts directly (with --global-name the
//   iife gets wrapped in "var echarts=…" and the default export nests under .default);
// - the provenance banner below is prepended, so it is part of the reproducible output.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'static', 'echarts.min.js');

const BANNER =
  '/* Apache ECharts v5.5.1 custom build (bar/line/pie/heatmap + tooltip/legend/grid/dataZoom/visualMap/axisPointer). ' +
  'Copyright 2018-2026 Apache Software Foundation, Apache-2.0. See NOTICE. */\n';

const result = await build({
  entryPoints: [path.join(root, 'build', 'echarts-entry.mjs')],
  bundle: true,
  minify: true,
  outfile,
  write: false,
  logLevel: 'warning',
});

const js = result.outputFiles[0].text;
writeFileSync(outfile, BANNER + js);

const sha = createHash('sha256').update(readFileSync(outfile)).digest('hex');
const kb = Math.round(statSync(outfile).size / 1024);
console.log(`static/echarts.min.js rebuilt: ${kb} KiB  sha256=${sha.slice(0, 16)}…`);
