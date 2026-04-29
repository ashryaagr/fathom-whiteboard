/**
 * Quick diagnostic — what elements actually land on the scene + bbox.
 *
 * Migrated to bootRenderHarness (#74). Sole composition: pure-evaluate
 * diagnostic — no PNG output. Boots the harness against the CLI fixture
 * via 'file-from-query' source, runs one evaluate() to gather element
 * counts / bbox / per-element summary, prints to stdout, disposes.
 */
import { bootRenderHarness } from './_render-harness.mjs';

const SCENE = process.argv[2] || '/tmp/wb-v32/recon-v32.excalidraw';

const consoleLines = [];
const harness = await bootRenderHarness({
  sceneSource: 'file-from-query',
  bootSceneArg: SCENE,
  onConsole: (line) => consoleLines.push(line),
  onPageError: (err) => consoleLines.push(`[pageerror] ${err.message}`),
  log: () => {}, // pre-#74 script wrote nothing during boot; preserve that
});

const info = await harness.evaluate(() => {
  const api = window.__api;
  const elements = api.getSceneElements();
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  const byType = {};
  for (const e of elements) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (typeof e.x === 'number' && typeof e.y === 'number') {
      const w = e.width || 0, h = e.height || 0;
      if (e.x < xMin) xMin = e.x;
      if (e.y < yMin) yMin = e.y;
      if (e.x + w > xMax) xMax = e.x + w;
      if (e.y + h > yMax) yMax = e.y + h;
    }
  }
  const summary = elements.map((e) => ({
    id: String(e.id).slice(0, 24),
    type: e.type,
    x: typeof e.x === 'number' ? Math.round(e.x) : null,
    y: typeof e.y === 'number' ? Math.round(e.y) : null,
    w: typeof e.width === 'number' ? Math.round(e.width) : null,
    h: typeof e.height === 'number' ? Math.round(e.height) : null,
    text: e.text ? String(e.text).slice(0, 40).replace(/\n/g, ' / ') : (e.label ? String(e.label.text || '').slice(0, 40) : undefined),
    fk: e.customData?.fathomKind,
  }));
  return { count: elements.length, byType, bbox: { xMin, yMin, xMax, yMax }, summary };
});
console.log('count:', info.count);
console.log('byType:', info.byType);
console.log('bbox  :', info.bbox);
console.log('--- elements ---');
for (const e of info.summary) {
  console.log(`  ${e.type.padEnd(10)} ${String(e.id).padEnd(26)} (${e.x},${e.y}) ${e.w}x${e.h} fk=${e.fk||'-'} ${e.text ? `"${e.text}"` : ''}`);
}
console.log('--- console (last 20) ---');
for (const l of consoleLines.slice(-20)) console.log(l);

await harness.dispose();
