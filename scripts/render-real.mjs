/**
 * Real Excalidraw render harness — Playwright + headless Chromium.
 *
 * The scene the user sees is the scene Excalidraw renders. Earlier
 * inspect-scene.mjs only checked geometry parity (rect bbox) and
 * missed visual bugs Excalidraw exposes (text-binding fallback,
 * autofit fights, font fallback widths). This harness mounts the
 * REAL @excalidraw/excalidraw package, lets it run its real render
 * pipeline, then either captures the page screenshot or calls
 * `exportToCanvas` (Excalidraw's own export) and writes the PNG.
 *
 * Usage:
 *   node scripts/render-real.mjs <path/to/whiteboard.excalidraw> [out.png]
 *
 * Defaults:
 *   - if [out.png] omitted, writes to /tmp/wb-real-<basename>.png
 *
 * Two PNGs per run:
 *   - <out>.page.png   — full-page screenshot of the live Excalidraw mount
 *   - <out>.canvas.png — Excalidraw's own exportToCanvas output
 *
 * The .page.png is the closest analog to "what the user sees". The
 * .canvas.png is what Excalidraw thinks it's drawing — when the two
 * disagree, the rendering pipeline has a bug between mount and export.
 *
 * Migrated to bootRenderHarness (#74). Composition: one-shot 2-PNG
 * diagnostic — `harness.screenshot(<out>.page.png)` for the live mount
 * view, `harness.render()` for the canvas export, then dispose.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bootRenderHarness } from './_render-harness.mjs';

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('usage: node scripts/render-real.mjs <scene.excalidraw> [out.png]');
  process.exit(2);
}
const scenePath = path.resolve(argv[0]);
if (!existsSync(scenePath)) {
  console.error(`scene not found: ${scenePath}`);
  process.exit(2);
}
const outBase = argv[1]
  ? path.resolve(argv[1]).replace(/\.png$/, '')
  : `/tmp/wb-real-${path.basename(scenePath, path.extname(scenePath))}-${Date.now()}`;

console.log(`scene  : ${scenePath}`);
console.log(`outBase: ${outBase}`);

const consoleLines = [];
let harness;
try {
  harness = await bootRenderHarness({
    sceneSource: 'file-from-query',
    bootSceneArg: scenePath,
    onConsole: (line) => consoleLines.push(line),
    onPageError: (err) => consoleLines.push(`[pageerror] ${err.message}`),
    log: (...args) => console.log(args.map((a) => String(a)).join(' ')),
  });
} catch (err) {
  console.error('--- boot failed, dumping context ---');
  console.error('console lines:');
  for (const line of consoleLines) console.error('  ' + line);
  console.error('error:', err && err.message);
  process.exit(1);
}

await harness.screenshot(`${outBase}.page.png`);

let canvasOk = true;
try {
  const png = await harness.render();
  await writeFile(`${outBase}.canvas.png`, png);
  console.log(`wrote  : ${outBase}.canvas.png`);
} catch (err) {
  canvasOk = false;
  console.log('exportToCanvas unavailable — only page.png written');
  consoleLines.push(`[render-error] ${err && err.message}`);
}

console.log(`wrote  : ${outBase}.page.png`);
console.log('--- console (last 30) ---');
for (const line of consoleLines.slice(-30)) console.log('  ' + line);

await harness.dispose();
if (!canvasOk) process.exit(0); // pre-#74 still exited 0 in this branch
