/**
 * Excalidraw render harness — single source of truth for the
 * Playwright + esbuild + headless Chromium + Excalidraw-mount
 * pipeline that 4 scripts under `scripts/` used to each carry their
 * own copy of. Lifted per Dedup F (#74).
 *
 * What this module owns (verbatim shared across all 4 callers
 * pre-#74, now lifted to one place):
 *
 *   1. esbuild bundle of `scripts/render-real-entry.jsx` (browser /
 *      esm / jsx auto / chrome120 / production define / no minify).
 *   2. A tiny in-process HTTP server on a random localhost port
 *      that serves:
 *        /                 → scripts/render-real.html
 *        /bundle.js        → the esbuild output
 *        /shim/react.js          ┐ tiny ESM re-exports of the UMD
 *        /shim/react-dom.js      ├ React/ReactDOM/JSX-runtime that
 *        /shim/react-jsx-runtime.js  Excalidraw's bundle imports.
 *        /scene            → JSON: per-script — see `sceneSource`
 *        any other path    → static-under-ROOT (with safeJoin
 *                            escape guard) for ad-hoc asset access
 *      The server is ALWAYS started — there is no "no-server" path.
 *      All 4 callers always need it.
 *   3. `chromium.launch({headless:true})` + `newContext({viewport,
 *      deviceScaleFactor})` + `newPage()` + boot to `${baseUrl}/?scene=...`
 *      + `waitForFunction(() => window.__ready === true)`.
 *   4. The two load-bearing fixes from round-12b that the production
 *      `look_at_scene` path depends on:
 *        - `Ex.convertToExcalidrawElements(elements, {regenerateIds:
 *          false})` re-route on every `updateScene` call. Expands
 *          labeled-shape sugar that the in-MCP rasteriser may emit.
 *        - bbox-aware `getDimensions` in `exportToCanvas` — explicit
 *          xMin/xMax sweep + PAD + scale, with empty-scene fallback
 *          to (0,0,800,600). Without this the export's default
 *          getDimensions sometimes returned a too-small canvas
 *          cropped to the first quadrant or to the viewport-fit,
 *          silently truncating the rendered image.
 *   5. Browser + server teardown in `dispose()` (idempotent).
 *
 * What this module DOES NOT own — caller's responsibility:
 *
 *   - CLI parsing. Each caller has its own argv shape (path-only vs.
 *     path-and-out vs. fixture-name).
 *   - Output sink. `render()` returns `Buffer`; `screenshot(path)`
 *     writes to disk; `evaluate()` returns whatever the caller's
 *     callback returns. No file-write opinions inside the helper.
 *   - Stdio protocols. `render-real-server.mjs` wraps the helper in
 *     a readline/JSON-line loop and writes a `{ready:true}` frame
 *     to stdout BEFORE its first request — that's the contract with
 *     `look_at_scene` MCP tool's render-client, not the helper's
 *     concern. The helper has zero awareness of stdin/stdout.
 *   - Persistent-vs-one-shot lifecycle. The "persistent" callers
 *     (render-real-server.mjs) and the "one-shot" callers (the
 *     other 3) differ ONLY in WHEN they call `dispose()`. There's
 *     no helper-side state machine for it.
 *   - Console / pageerror / network-request logging. All optional
 *     hooks (`onConsole`, `onPageError`, `onRequest`, `onResponse`).
 *     Helper attaches NO listeners by default.
 *
 * Per-script axes the helper covers (verbatim from #74 design check):
 *
 *   - sceneSource: 'file-from-query' | {kind:'in-memory', initial:...}
 *   - viewport / deviceScaleFactor (defaults: 2400×1800, dpr 2)
 *   - bootTimeoutMs (default 30000)
 *   - exportPadding / exportScale (defaults 40 / 2 — round-12b)
 *   - 4 optional event hooks (console / pageerror / request / response)
 *   - log() callback (default: stderr with [render-harness] prefix;
 *     pass a no-op for protocol-mode callers like render-real-server)
 *
 * Per-script composition patterns expressed via the returned handle:
 *
 *   - render-real.mjs       — `await harness.screenshot(p1);
 *                              const png = await harness.render();
 *                              await writeFile(p2, png);`
 *                              (one-shot 2-PNG diagnostic)
 *   - render-real-server.mjs — `for await (line of stdin) {
 *                                await harness.updateScene(scene);
 *                                const png = await harness.render();
 *                                stdout.write(...);
 *                              }`
 *                              (persistent stdio render server)
 *   - wb-inspect-render.mts — `const fonts = await harness.evaluate(...);
 *                              const widths = await harness.evaluate(...);
 *                              ...; await harness.dispose();`
 *                              (one-shot pure-evaluate diagnostic)
 *   - wb-v32-debug.mjs      — `const info = await harness.evaluate(...);
 *                              ...; await harness.dispose();`
 *                              (one-shot pure-evaluate diagnostic)
 *
 * Module is .mjs (not .mts) because 2 of the 4 callers are .mjs
 * scripts spawned with plain `node` (most importantly
 * `render-real-server.mjs`, which `whiteboard-mcp.ts` spawns via
 * `spawn('node', [scriptPath])` — adding a tsx loader to that path
 * is out of scope for #74 and would add cold-start overhead to the
 * `look_at_scene` hot path). JSDoc `@typedef`s preserve IDE
 * intellisense without requiring a TS loader at runtime.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Minimal scene shape — `elements` + optional `appState` + optional
 * `files`. Mirrors what Excalidraw consumes; we don't import the
 * package's stricter type because the helper is bundle-agnostic.
 *
 * @typedef {object} RenderHarnessScene
 * @property {unknown[]} [elements]
 * @property {Record<string, unknown>} [appState]
 * @property {Record<string, unknown>} [files]
 */

/**
 * Discriminated union for `/scene` resolution.
 *
 * - `'file-from-query'`: the boot URL passes `?scene=<absPath>`,
 *   and `/scene?path=<absPath>` reads + returns that file.
 * - `{kind:'in-memory', initial}`: `/scene` always returns the
 *   helper's in-memory scene. The boot URL still passes a `scene=`
 *   query (any value) so each request URL is unique. Update via
 *   `harness.updateScene(...)`.
 *
 * @typedef {'file-from-query' | {kind: 'in-memory', initial: RenderHarnessScene}} SceneSource
 */

/**
 * @typedef {object} BootRenderHarnessOpts
 * @property {SceneSource} sceneSource — How `/scene` is resolved.
 * @property {{width: number, height: number}} [viewport] — Default 2400×1800.
 * @property {number} [deviceScaleFactor] — Default 2.
 * @property {number} [bootTimeoutMs] — Default 30000.
 * @property {(line: string) => void} [onConsole] — Page console event hook.
 * @property {(err: Error) => void} [onPageError] — Page error event hook.
 * @property {(url: string) => void} [onRequest] — Request event hook.
 * @property {(status: number, url: string) => void} [onResponse] — Response event hook.
 * @property {(...args: unknown[]) => void} [log] — Logger. Default writes
 *   to stderr with `[render-harness]` prefix. Pass a no-op for
 *   protocol-mode callers (render-real-server.mjs) whose stdout is
 *   reserved for JSON-line response frames.
 * @property {number} [exportPadding] — Default 40 (round-12b).
 * @property {number} [exportScale] — Default 2 (round-12b).
 * @property {string} [projectRoot] — safeJoin sandbox root for
 *   static-file-under-ROOT serving. Defaults to the repo root.
 * @property {string} [bootSceneArg] — Override boot URL's `scene=`
 *   query value. Defaults: `'initial'` for in-memory, '' for
 *   file-from-query (the diagnostic scripts that pass a fixture path
 *   through CLI args use this knob).
 */

/**
 * @typedef {object} RenderHarnessHandle
 * @property {string} baseUrl — Localhost http origin the harness page loaded from.
 * @property {(scene: RenderHarnessScene) => Promise<void>} updateScene —
 *   Push a fresh scene through the live Excalidraw API. Routes
 *   elements through `Ex.convertToExcalidrawElements({regenerateIds:
 *   false})` (round-12b sugar-expansion fix), sanitises appState to
 *   the allow-list, then calls `api.updateScene(...)` and
 *   `api.scrollToContent(undefined, {fitToContent:true,
 *   animate:false})` and waits 2× rAF for paint. Updates the
 *   helper's in-memory `currentScene` so the next render() / next
 *   /scene fetch sees the new scene.
 *
 *   No-op WARNING: for `'file-from-query'` sources, this STILL
 *   pushes the scene through the live API (so `render()` works the
 *   same as for in-memory) but the next `/scene` fetch will NOT
 *   see it — that mode reads from the file each request. Callers
 *   that want post-boot scene swaps should use the in-memory
 *   source.
 * @property {(opts?: {scale?: number}) => Promise<Buffer>} render —
 *   exportToCanvas → PNG `Buffer`. Uses the bbox-aware
 *   `getDimensions` (round-12b fix) with empty-scene fallback.
 *   Optional `{scale}` overrides the boot-time `exportScale` for
 *   this single render (e.g. render-real-server.mjs accepts a
 *   per-request scale via the protocol).
 * @property {(outPath: string) => Promise<void>} screenshot —
 *   Full-page page.screenshot to `outPath`.
 * @property {(fn: Function, arg?: unknown) => Promise<unknown>} evaluate —
 *   Run an arbitrary `evaluate(fn, arg?)` against the live page.
 *   The diagnostic scripts (wb-inspect-render, wb-v32-debug) use
 *   this to extract per-element data without re-implementing the
 *   page-side fetch dance. (Generic-bound type lost in JSDoc port;
 *   callers cast the return as needed.)
 * @property {() => Promise<void>} dispose —
 *   Tear down browser + http server. Idempotent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** React/ReactDOM/JSX-runtime ESM shims that re-export the
 * UMD-mounted globals. Excalidraw's bundle imports `react` /
 * `react-dom` / `react/jsx-runtime` as bare specifiers; the boot
 * HTML's importmap routes them to these strings. Lifted from the
 * 3 callers that previously inlined identical copies. */
const SHIM_REACT = `const R = window.React; export default R; export const Children = R.Children; export const Component = R.Component; export const Fragment = R.Fragment; export const PureComponent = R.PureComponent; export const StrictMode = R.StrictMode; export const Suspense = R.Suspense; export const cloneElement = R.cloneElement; export const createContext = R.createContext; export const createElement = R.createElement; export const createRef = R.createRef; export const forwardRef = R.forwardRef; export const isValidElement = R.isValidElement; export const lazy = R.lazy; export const memo = R.memo; export const useCallback = R.useCallback; export const useContext = R.useContext; export const useDebugValue = R.useDebugValue; export const useDeferredValue = R.useDeferredValue; export const useEffect = R.useEffect; export const useId = R.useId; export const useImperativeHandle = R.useImperativeHandle; export const useInsertionEffect = R.useInsertionEffect; export const useLayoutEffect = R.useLayoutEffect; export const useMemo = R.useMemo; export const useReducer = R.useReducer; export const useRef = R.useRef; export const useState = R.useState; export const useSyncExternalStore = R.useSyncExternalStore; export const useTransition = R.useTransition; export const startTransition = R.startTransition; export const version = R.version;`;
const SHIM_REACT_DOM = `const RD = window.ReactDOM; export default RD; export const createPortal = RD.createPortal; export const createRoot = RD.createRoot; export const flushSync = RD.flushSync; export const hydrateRoot = RD.hydrateRoot; export const render = RD.render; export const unmountComponentAtNode = RD.unmountComponentAtNode; export const unstable_batchedUpdates = RD.unstable_batchedUpdates; export const findDOMNode = RD.findDOMNode; export const version = RD.version;`;
const SHIM_JSX_RUNTIME = `const R = window.React; const jsx = (type, props, key) => R.createElement(type, key !== undefined ? Object.assign({key}, props) : props); export { jsx, jsx as jsxs, jsx as jsxDEV }; export const Fragment = R.Fragment;`;

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + rel);
  if (!full.startsWith(root)) throw new Error('path escape: ' + rel);
  return full;
}

/** @param {...unknown} args */
function defaultLog(...args) {
  process.stderr.write('[render-harness] ' + args.map((a) => String(a)).join(' ') + '\n');
}

/**
 * Boot the Excalidraw render harness: esbuild the entry, start an
 * http server, launch chromium, mount the page, wait for ready.
 * Returns a handle exposing primitives the 4 callers compose into
 * their own output flows.
 *
 * @param {BootRenderHarnessOpts} opts
 * @returns {Promise<RenderHarnessHandle>}
 */
export async function bootRenderHarness(opts) {
  const log = opts.log ?? defaultLog;
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '..');
  const viewport = opts.viewport ?? { width: 2400, height: 1800 };
  const deviceScaleFactor = opts.deviceScaleFactor ?? 2;
  const bootTimeoutMs = opts.bootTimeoutMs ?? 30000;
  const exportPadding = opts.exportPadding ?? 40;
  const exportScale = opts.exportScale ?? 2;

  // --- esbuild the entry ----------------------------------------------
  log('bundling render-real-entry.jsx ...');
  const buildResult = await esbuild.build({
    entryPoints: [path.join(__dirname, 'render-real-entry.jsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    minify: false,
    logLevel: 'silent',
  });
  const bundleJs = buildResult.outputFiles[0].contents;
  log(`bundle ${bundleJs.byteLength} bytes`);

  // --- in-memory scene cache (only meaningful for in-memory source) ---
  /** @type {RenderHarnessScene} */
  let currentScene =
    typeof opts.sceneSource === 'object' && opts.sceneSource.kind === 'in-memory'
      ? opts.sceneSource.initial
      : { elements: [], appState: { viewBackgroundColor: '#fafaf7' } };

  // --- http server ----------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/render-real.html') {
        const html = await readFile(path.join(__dirname, 'render-real.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
        return;
      }
      if (url.pathname === '/bundle.js') {
        res.writeHead(200, { 'content-type': MIME['.js'] });
        res.end(Buffer.from(bundleJs));
        return;
      }
      if (url.pathname === '/shim/react.js') {
        res.writeHead(200, { 'content-type': MIME['.js'] });
        res.end(SHIM_REACT);
        return;
      }
      if (url.pathname === '/shim/react-dom.js') {
        res.writeHead(200, { 'content-type': MIME['.js'] });
        res.end(SHIM_REACT_DOM);
        return;
      }
      if (url.pathname === '/shim/react-jsx-runtime.js') {
        res.writeHead(200, { 'content-type': MIME['.js'] });
        res.end(SHIM_JSX_RUNTIME);
        return;
      }
      if (url.pathname === '/scene') {
        if (opts.sceneSource === 'file-from-query') {
          const p = url.searchParams.get('path');
          if (!p) {
            res.writeHead(400);
            res.end('missing path');
            return;
          }
          const buf = await readFile(p);
          res.writeHead(200, { 'content-type': MIME['.json'] });
          res.end(buf);
          return;
        }
        // in-memory mode: always return the helper's currentScene.
        res.writeHead(200, { 'content-type': MIME['.json'] });
        res.end(JSON.stringify(currentScene));
        return;
      }
      // Static-under-ROOT (with safeJoin escape guard).
      const full = safeJoin(projectRoot, url.pathname);
      if (!existsSync(full)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const st = await stat(full);
      if (st.isDirectory()) {
        res.writeHead(404);
        res.end('dir');
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(await readFile(full));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && /** @type {Error} */ (err).message));
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server bound to non-AF_INET address');
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`server ${baseUrl}`);

  // --- chromium + page ------------------------------------------------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();

  if (opts.onConsole) page.on('console', (msg) => opts.onConsole(`[${msg.type()}] ${msg.text()}`));
  if (opts.onPageError) page.on('pageerror', (err) => opts.onPageError(err));
  if (opts.onRequest) page.on('request', (r) => opts.onRequest(r.url()));
  if (opts.onResponse) page.on('response', (r) => opts.onResponse(r.status(), r.url()));

  // Boot URL — `scene=` query is always present so each request URL
  // is unique; the value is only used by the file-from-query branch
  // of the http server, but the page-side render-real-entry.jsx
  // includes it in its `/scene?path=...` fetch unconditionally.
  const bootSceneArg =
    opts.bootSceneArg ??
    (opts.sceneSource === 'file-from-query' ? '' : 'initial');
  const bootUrl = `${baseUrl}/?scene=${encodeURIComponent(bootSceneArg)}`;
  await page.goto(bootUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => /** @type {{__ready?: boolean}} */ (window).__ready === true, null, {
    timeout: bootTimeoutMs,
  });
  log('chromium booted, harness ready');

  // --- handle methods -------------------------------------------------

  let disposed = false;

  /**
   * @param {RenderHarnessScene} scene
   * @returns {Promise<void>}
   */
  async function updateScene(scene) {
    currentScene = scene;
    const result = await page.evaluate(async (s) => {
      const w = /** @type {any} */ (window);
      const api = w.__api;
      const Ex = w.__ex;
      if (!api) return { error: 'api not ready' };
      // Sanitise appState the same way the production hydrate path
      // does — allow-listed keys only.
      const a = (s.appState && typeof s.appState === 'object' ? s.appState : {});
      const allow = ['viewBackgroundColor', 'gridSize', 'theme', 'currentItemFontFamily', 'currentItemFontSize'];
      /** @type {Record<string, unknown>} */
      const cleanState = { viewBackgroundColor: '#fafaf7' };
      for (const k of allow) {
        if (k in a && a[k] !== undefined) cleanState[k] = a[k];
      }
      // Round-12b rasteriser fix: route incoming elements through
      // convertToExcalidrawElements so labeled-shape sugar (e.g. a
      // rect with `label: {text, ...}`) expands into the rect + bound
      // text pair the renderer expects. The boot path already does
      // this on initial mount; doing it on subsequent updateScene
      // calls keeps every scene source consistent.
      let inElements = (s.elements ?? []);
      if (Ex && typeof Ex.convertToExcalidrawElements === 'function') {
        try {
          inElements = Ex.convertToExcalidrawElements(inElements, { regenerateIds: false });
        } catch {
          inElements = (s.elements ?? []);
        }
      }
      api.updateScene({ elements: inElements, appState: cleanState });
      api.scrollToContent(undefined, { fitToContent: true, animate: false });
      // Two rAFs for paint to settle.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))));
      return { ok: true };
    }, scene);
    if (result && /** @type {{error?: string}} */ (result).error) {
      throw new Error(/** @type {{error: string}} */ (result).error);
    }
  }

  /**
   * @param {{scale?: number}} [renderOpts]
   * @returns {Promise<Buffer>}
   */
  async function render(renderOpts) {
    const PAD = exportPadding;
    const SCALE = renderOpts?.scale ?? exportScale;
    const result = await page.evaluate(async (args) => {
      const w = /** @type {any} */ (window);
      const api = w.__api;
      const Ex = w.__ex;
      if (!api || !Ex || !Ex.exportToCanvas) return { error: 'api not ready' };
      try {
        // Round-12b rasteriser fix: compute scene bbox EXPLICITLY.
        // The previous default `getDimensions` returned a too-small
        // canvas — round-11 in-MCP critic saw a top-left-cropped
        // render with node labels missing because the canvas was
        // sized to the first-quadrant bbox or to the viewport-fit
        // rather than to the full scene.
        const elements = api.getSceneElements();
        let xMin = Infinity,
          yMin = Infinity,
          xMax = -Infinity,
          yMax = -Infinity;
        for (const e of elements) {
          if (typeof e.x !== 'number' || typeof e.y !== 'number') continue;
          const wEl = e.width ?? 0;
          const hEl = e.height ?? 0;
          if (e.x < xMin) xMin = e.x;
          if (e.y < yMin) yMin = e.y;
          if (e.x + wEl > xMax) xMax = e.x + wEl;
          if (e.y + hEl > yMax) yMax = e.y + hEl;
        }
        // Empty scene fallback (round-12b): keep a small canvas
        // instead of NaN.
        if (!isFinite(xMin) || !isFinite(yMin)) {
          xMin = 0;
          yMin = 0;
          xMax = 800;
          yMax = 600;
        }
        const sceneW = xMax - xMin + 2 * args.PAD;
        const sceneH = yMax - yMin + 2 * args.PAD;
        const canvas = await Ex.exportToCanvas({
          elements,
          appState: {
            ...api.getAppState(),
            exportBackground: true,
            exportWithDarkMode: false,
            viewBackgroundColor: '#fafaf7',
            exportPadding: args.PAD,
          },
          files: api.getFiles(),
          getDimensions: () => ({ width: sceneW * args.SCALE, height: sceneH * args.SCALE, scale: args.SCALE }),
        });
        return { dataUrl: canvas.toDataURL('image/png') };
      } catch (err) {
        return { error: err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : String(err) };
      }
    }, { PAD, SCALE });
    if (result && /** @type {{error?: string}} */ (result).error) {
      throw new Error(/** @type {{error: string}} */ (result).error);
    }
    const dataUrl = /** @type {{dataUrl: string}} */ (result).dataUrl;
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return Buffer.from(b64, 'base64');
  }

  /**
   * @param {string} outPath
   * @returns {Promise<void>}
   */
  async function screenshot(outPath) {
    await page.screenshot({ path: outPath, fullPage: false });
  }

  /**
   * @param {Function} fn
   * @param {unknown} [arg]
   * @returns {Promise<unknown>}
   */
  async function evaluate(fn, arg) {
    return await page.evaluate(/** @type {any} */ (fn), /** @type {any} */ (arg));
  }

  /** @returns {Promise<void>} */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      await browser.close();
    } catch {
      /* swallow — best-effort */
    }
    try {
      await new Promise((r) => server.close(() => r(undefined)));
    } catch {
      /* swallow — best-effort */
    }
  }

  return { baseUrl, updateScene, render, screenshot, evaluate, dispose };
}
