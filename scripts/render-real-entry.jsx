// Bundled by esbuild from scripts/render-real.mjs. Mounts Excalidraw
// against a scene fetched from the local server, exposes the API on
// window.__api, and signals readiness via window.__ready.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as Ex from '@excalidraw/excalidraw';

window.__React = React;
window.__ex = Ex;
window.__ready = false;

async function boot() {
  const params = new URLSearchParams(location.search);
  const scenePath = params.get('scene') || '';
  const sceneRes = await fetch('/scene?path=' + encodeURIComponent(scenePath));
  if (!sceneRes.ok) {
    document.getElementById('root').innerText = 'scene fetch failed: ' + sceneRes.status;
    return;
  }
  const scene = await sceneRes.json();
  // Mirror the production hydrate path's appState scrub
  // (src/renderer/whiteboard/WhiteboardTab.tsx::sanitiseAppStateForDisk).
  // Allowlist of JSON-safe fields, with extra defence on the numeric
  // ones that JSON-roundtrip into null when the live app saved them
  // mid-mount (zoom.value / scrollX / scrollY → "NaN%" zoom indicator).
  const a = (scene.appState && typeof scene.appState === 'object') ? scene.appState : {};
  const appState = { viewBackgroundColor: '#fafaf7' };
  const allow = ['viewBackgroundColor','gridSize','theme','zoom','scrollX','scrollY','currentItemFontFamily','currentItemFontSize'];
  for (const k of allow) {
    if (!(k in a) || a[k] === undefined) continue;
    if (k === 'zoom') {
      const z = a[k];
      const v = z && typeof z === 'object' ? z.value : undefined;
      if (typeof v === 'number' && Number.isFinite(v)) appState[k] = { value: v };
      continue;
    }
    if (k === 'scrollX' || k === 'scrollY') {
      const v = a[k];
      if (typeof v === 'number' && Number.isFinite(v)) appState[k] = v;
      continue;
    }
    appState[k] = a[k];
  }

  // Run elements through convertToExcalidrawElements so labeled-shape
  // skeletons ({type:'rectangle', label:{text,fontSize}}) get expanded
  // into Excalidraw's rect+bound-text pair with auto-fitted width/
  // height/text wrapping. Already-expanded elements (with no `label`
  // sugar) pass through unchanged because convertToExcalidrawElements
  // is idempotent for elements that already have all required fields.
  let processedElements;
  try {
    processedElements = Ex.convertToExcalidrawElements(scene.elements || [], {
      regenerateIds: false,
    });
  } catch (err) {
    console.warn('[render-real] convertToExcalidrawElements failed; using raw elements', err);
    processedElements = scene.elements || [];
  }

  let api = null;
  function App() {
    return React.createElement(
      'div',
      { style: { width: '100vw', height: '100vh' } },
      React.createElement(Ex.Excalidraw, {
        excalidrawAPI: (a) => { api = a; window.__api = a; },
        initialData: { elements: processedElements, appState },
        viewModeEnabled: true,
      }),
    );
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));

  for (let i = 0; i < 200; i++) {
    if (api && api.getSceneElements && api.getSceneElements().length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Fit to content so the page-screenshot path captures the whole scene.
  if (api && api.scrollToContent) {
    try {
      api.scrollToContent(undefined, { fitToContent: true, animate: false });
    } catch {}
  }
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch {}
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  window.__ready = true;
}
boot().catch((err) => {
  console.error(err);
  document.getElementById('root').innerText = 'boot error: ' + (err && err.message);
});
