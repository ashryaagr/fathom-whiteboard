/**
 * Persistent Excalidraw render server — spawned by the in-product
 * Pass 2 agent's MCP wrapper to power `look_at_scene`.
 *
 * Runs the same Playwright + headless Chromium + Excalidraw mount
 * as `scripts/render-real.mjs` (the one-shot CLI harness), but stays
 * alive across many scenes:
 *
 *   parent → child (stdin):  one JSON-line per request, framed by `\n`:
 *     { "id": 1, "op": "render", "scene": {...}, "scale": 2 }
 *     { "id": 2, "op": "shutdown" }
 *
 *   child → parent (stdout): one JSON-line per response, framed by `\n`:
 *     { "id": 1, "ok": true,  "pngBase64": "iVBORw0K..." }
 *     { "id": 1, "ok": false, "error": "..." }
 *
 * Other stdout (boot logs, console-forwarding) goes to STDERR so the
 * parent's stdout-line parser sees only response frames. Never mix
 * them — use process.stderr.write for any human-readable diagnostic.
 *
 * Lifecycle: parent spawns this; first `render` is slow (~3s — boot
 * Chromium + esbuild bundle + Excalidraw mount), subsequent renders
 * are fast (~500-700ms — just `api.updateScene` + `exportToCanvas`).
 * Parent sends `shutdown` (or just kills the process) when Pass 2
 * finishes.
 *
 * Migrated to bootRenderHarness (#74). All harness internals
 * (esbuild bundle, http server, chromium boot, /scene routing,
 * round-12b convertToExcalidrawElements + bbox-aware getDimensions
 * fixes) live in `_render-harness.mjs`. This file owns ONLY the
 * stdio JSON-line protocol that wraps the harness.
 */

import readline from 'node:readline';
import { bootRenderHarness } from './_render-harness.mjs';

function log(...args) {
  process.stderr.write('[render-server] ' + args.map((a) => String(a)).join(' ') + '\n');
}

// Boot the harness with an in-memory scene source. The first render
// request will replace `currentScene` via harness.updateScene().
const harness = await bootRenderHarness({
  sceneSource: { kind: 'in-memory', initial: { elements: [], appState: { viewBackgroundColor: '#fafaf7' } } },
  onPageError: (err) => log('[pageerror]', err.message),
  log, // route helper boot logs to stderr (stdout is reserved for protocol frames)
});

log('chromium booted, harness ready');

// --- stdio request loop ------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'bad json: ' + (err && err.message) }) + '\n');
    return;
  }
  const { id = null, op } = req;
  try {
    if (op === 'shutdown') {
      process.stdout.write(JSON.stringify({ id, ok: true }) + '\n');
      await harness.dispose();
      process.exit(0);
    }
    if (op === 'render') {
      await harness.updateScene(req.scene);
      const png = await harness.render({ scale: req.scale ?? 2 });
      process.stdout.write(JSON.stringify({ id, ok: true, pngBase64: png.toString('base64') }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({ id, ok: false, error: 'unknown op: ' + op }) + '\n');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log('error in op', op, msg);
    process.stdout.write(JSON.stringify({ id, ok: false, error: msg }) + '\n');
  }
});

rl.on('close', async () => {
  log('stdin closed, shutting down');
  try {
    await harness.dispose();
  } catch {
    /* swallow */
  }
  process.exit(0);
});
