/**
 * One-off diagnostic — runs render-real's harness against a scene
 * and prints (a) what fonts loaded in the page, (b) the post-convert
 * widths of every text element. Helps decide whether the visible
 * "clipping" in the PNG is a font-load issue, a wrap miscount, or a
 * pure positioning issue.
 *
 * Usage: `npx tsx scripts/wb-inspect-render.mts <scene.excalidraw>`
 *
 * Migrated to bootRenderHarness (#74). Sole composition: pure-evaluate
 * diagnostic — no PNG output. Boots harness against a CLI fixture via
 * 'file-from-query' source, runs three evaluate() calls (fonts /
 * post-convert text widths / container rect bounds), prints to stdout,
 * disposes.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
// .mjs import works under tsx (the script is invoked with `npx tsx`)
// AND under plain node — see _render-harness.mjs banner for the .mjs
// vs .mts decision.
// eslint-disable-next-line import/extensions
import { bootRenderHarness } from './_render-harness.mjs';

const scenePath = path.resolve(process.argv[2] ?? '/tmp/wb-iter/clean-l1.excalidraw');
if (!existsSync(scenePath)) {
  console.error(`scene not found: ${scenePath}`);
  process.exit(2);
}

const requests: string[] = [];
const responses: string[] = [];
const harness = await bootRenderHarness({
  sceneSource: 'file-from-query',
  bootSceneArg: scenePath,
  onRequest: (url) => requests.push(url),
  onResponse: (status, url) => responses.push(`${status} ${url}`),
  log: () => {}, // pre-#74 script wrote nothing during boot
});

console.log('=== Font loading status ===');
const fontStatus = (await harness.evaluate(() => {
  const fonts: Array<{ family: string; status: string }> = [];
  document.fonts.forEach((f) => fonts.push({ family: f.family, status: f.status }));
  return fonts;
})) as Array<{ family: string; status: string }>;
for (const f of fontStatus) console.log(`  ${f.status} — ${f.family}`);

console.log('\n=== Network requests for woff/woff2 ===');
for (const r of [...new Set(requests)]) {
  if (/\.woff2?(\?|$)/.test(r)) console.log(`  ${r}`);
}

console.log('\n=== Post-convert text element widths ===');
const textInfo = (await harness.evaluate(() => {
  const api = (window as unknown as { __api?: { getSceneElements: () => unknown[] } }).__api;
  if (!api) return [];
  const els = api.getSceneElements() as Array<{
    id?: string;
    type?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    text?: string;
    fontFamily?: number;
    fontSize?: number;
    containerId?: string;
  }>;
  return els
    .filter((e) => e.type === 'text')
    .map((e) => ({
      id: e.id,
      text: e.text,
      x: Math.round(e.x ?? 0),
      y: Math.round(e.y ?? 0),
      w: Math.round(e.width ?? 0),
      h: Math.round(e.height ?? 0),
      fontFamily: e.fontFamily,
      fontSize: e.fontSize,
      containerId: e.containerId,
    }));
})) as Array<Record<string, unknown>>;
for (const t of textInfo) console.log(`  ${JSON.stringify(t)}`);

console.log('\n=== Container rect bounds (for comparison) ===');
const rectInfo = (await harness.evaluate(() => {
  const api = (window as unknown as { __api?: { getSceneElements: () => unknown[] } }).__api;
  if (!api) return [];
  const els = api.getSceneElements() as Array<{
    id?: string;
    type?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    customData?: { fathomKind?: string };
  }>;
  return els
    .filter((e) => e.type === 'rectangle' && e.customData?.fathomKind === 'wb-node')
    .map((e) => ({
      id: e.id,
      x: Math.round(e.x ?? 0),
      y: Math.round(e.y ?? 0),
      w: Math.round(e.width ?? 0),
      h: Math.round(e.height ?? 0),
    }));
})) as Array<Record<string, unknown>>;
for (const r of rectInfo) console.log(`  ${JSON.stringify(r)}`);

await harness.dispose();
