# fathom-whiteboard demo (skeleton)

A minimal Vite + Node sidecar app that uses `fathom-whiteboard/pipeline` to generate a whiteboard from a pre-built paper index, and `fathom-whiteboard/renderer` to render it.

This is a **skeleton** — it documents the import shape + the file boundaries the demo is expected to fill. The full implementation (Vite app, Node sidecar with Server-Sent-Events streaming, demo paper indexes) is Phase 2.5.

## Shape

```
examples/demo/
├── package.json       # Vite + Node sidecar workspace
├── README.md          # this file
├── web/               # Vite app
│   ├── index.html
│   ├── App.tsx        # mounts WhiteboardTab; provides createNodeSidecarHost
│   └── vite.config.ts
└── server/            # Node sidecar (Express or Hono)
    ├── server.ts      # HTTP + SSE endpoints implementing the WhiteboardHost contract
    └── paper/         # Pre-built paper indexes for the demo
        └── reconviagen.lens/
            ├── content.md
            ├── digest.json
            └── images/
```

## Host implementation outline

The demo's `createNodeSidecarHost(opts)` is the canonical worked example of a non-Electron host. Sketch:

```ts
import type { WhiteboardHost } from 'fathom-whiteboard/renderer';

export function createNodeSidecarHost({ baseUrl }: { baseUrl: string }): WhiteboardHost {
  return {
    async generate(req, cb) {
      const requestId = crypto.randomUUID();
      // POST /generate → server runs pipeline.runPass1 + runPass2
      // GET /events?requestId={id} → SSE stream of {pass1Delta, pass1Done, ...}
      // route SSE events to cb.onPass1Delta / cb.onPass1Done / etc
      const eventSource = new EventSource(`${baseUrl}/events?requestId=${requestId}`);
      eventSource.addEventListener('pass1-delta', (e) => cb?.onPass1Delta?.(JSON.parse(e.data).text));
      // ... etc for the other 6 callbacks
      await fetch(`${baseUrl}/generate`, { method: 'POST', body: JSON.stringify({ ...req, requestId }) });
      return {
        requestId,
        abort: () => fetch(`${baseUrl}/abort/${requestId}`, { method: 'POST' }),
      };
    },
    // ... 15 more methods ...
  };
}
```

## Server-side pipeline integration

```ts
import { runPass1, runPass2 } from 'fathom-whiteboard/pipeline';

app.post('/generate', async (req, res) => {
  const { requestId, paperHash, pdfPath, purposeAnchor } = req.body;
  const stream = sseStreamFor(requestId);

  const pass1 = await runPass1({
    paperHash, indexPath: paperHash + '.lens',
    purposeAnchor,
    onProgress: (text) => stream.send('pass1-delta', { text }),
    onArtifact: async (a) => stream.send('artifact', a),
  });
  stream.send('pass1-done', { understanding: pass1.understanding, costUsd: pass1.costUsd, latencyMs: pass1.latencyMs });

  const pass2 = await runPass2({
    paperHash, indexPath: paperHash + '.lens',
    understanding: pass1.understanding,
    renderRequest: 'Render the Level 1 diagram',
    level: 1,
    onProgress: (text) => stream.send('pass2-delta', { text }),
    onArtifact: async (a) => stream.send('artifact', a),
  });
  stream.send('pass2-done', { raw: pass2.raw, costUsd: pass2.costUsd, cachedPrefixHit: false });

  stream.send('done', { totalCost: pass1.costUsd + pass2.costUsd });
});
```

## Status

Skeleton only. The above sketches the API shape but isn't runnable. Implementation lands in Phase 2.5 once the package's API stabilises.
