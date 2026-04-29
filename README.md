# fathom-whiteboard

Generate explanatory whiteboards from research papers using Claude. Pipeline + React UI + render harness, host-agnostic.

Extracted from [Fathom](https://github.com/ashryaagr/Fathom) (Phase 2, 2026-04-29). The whiteboard pipeline + React surface that lives inside Fathom now lives here as a standalone module that any host (Electron app, web app with a Node sidecar, CLI) can consume.

## Quickstart

The package ships two entry points — a Node-side pipeline and a React-side renderer — and the host wires them together.

```ts
// Pipeline (Node) — produce a whiteboard JSON from a pre-built paper index.
import {
  runPass1, runPass2,
  type PaperIndex,
} from 'fathom-whiteboard/pipeline';

const paper: PaperIndex = {
  paperHash: 'abc123',
  indexPath: '/path/to/paper.lens',
  readContent: () => readFile('/path/to/paper.lens/content.md', 'utf-8'),
  readDigest: () => readFile('/path/to/paper.lens/digest.json', 'utf-8').catch(() => null),
  resolveFigurePath: (rel) => '/path/to/paper.lens/' + rel,
};

const pass1 = await runPass1({
  paperHash: paper.paperHash,
  indexPath: paper.indexPath,
  onProgress: (text) => process.stdout.write(text),
  onArtifact: async ({ name, body }) => writeFile('/out/' + name, body),
});

const pass2 = await runPass2({
  paperHash: paper.paperHash,
  indexPath: paper.indexPath,
  understanding: pass1.understanding,
  renderRequest: 'Render the Level 1 diagram',
  level: 1,
  onArtifact: async ({ name, body }) => writeFile('/out/' + name, body),
});
// pass2.raw is the Excalidraw scene JSON.
```

```tsx
// Renderer (React) — drop the WhiteboardTab into any React tree.
import {
  WhiteboardTab, WhiteboardHostProvider,
  type WhiteboardHost, type WhiteboardPaperRef,
} from 'fathom-whiteboard/renderer';

const host: WhiteboardHost = createMyHost(/* IPC bridge or fetch client */);
const paper: WhiteboardPaperRef = {
  contentHash: 'abc123',
  indexPath: '/path/to/paper.lens',
};

<WhiteboardHostProvider host={host}>
  <WhiteboardTab paper={paper} />
</WhiteboardHostProvider>
```

## Pipeline API

Node-side. Each function takes the paper context, runs Claude (via the Claude Agent SDK), and returns a result. Streaming + persistence flow through callbacks.

| Function | Purpose |
| --- | --- |
| `runPass1(args)` | Read the whole paper into Opus 4.7's 1M context, emit a markdown understanding doc. |
| `runPass2(args)` | Single-shot Pass 2 — emit a Level 1 or Level 2 Excalidraw scene. |
| `runPass2StepLoop(args)` | Pass 2 with per-step yields — drives the live-streaming canvas in the renderer. |
| `runChatStepLoop(args)` | Chat-refinement turn — author a chat-frame on the existing canvas. |
| `runCritique(args)` | Pass 2.5 visual critic — grades a rendered PNG, returns `{pass, defects, fixes}`. |
| `runVerifier(args)` | Cross-checks Pass 1's quotes against the paper's `content.md`. |
| `createWhiteboardMcpWithStateAccess(opts)` | MCP server factory (used internally by Pass 2; exposed for advanced hosts). |
| `resolveClaudeExecutablePath()` | Best-effort lookup of the Claude CLI binary on disk. |

**Persistence is host-supplied.** Pipeline functions accept `onArtifact?: (a: PipelineArtifact) => Promise<void>`. The pipeline never writes to disk; the host decides where output goes.

```ts
// PipelineArtifact:
{ type: 'understanding', name: 'whiteboard-understanding.md', body: string }
{ type: 'issues',        name: 'whiteboard-issues.json',     body: string }
{ type: 'render-snapshot', name: 'wb-postexport-...png',     body: Buffer }
```

**Visual critique takes bytes, not paths.** `runCritique` accepts `pngBytes: Buffer`. Hosts that persist the PNG separately (for offline inspection) read the file → pass bytes; hosts that operate purely in-memory pass the buffer they just produced.

## Renderer API

React-side. The whole tree consumes a `WhiteboardHost` provided via `<WhiteboardHostProvider>`.

| Component | Purpose |
| --- | --- |
| `WhiteboardTab` | The full whiteboard surface — Excalidraw mount + breadcrumb + chat rail + regenerate controls. |
| `WhiteboardChat` | The right rail — Pass 1/Pass 2 streaming display, then chat-refinement turns. |
| `WhiteboardConsent` | Cost-disclosure gate before first generation. |
| `WhiteboardRegenerateButton` | Top-right Regenerate + Clear controls. |
| `WhiteboardBreadcrumb` | Inline breadcrumb for the L1/L2 zoom. |

| Hook / Provider | Purpose |
| --- | --- |
| `WhiteboardHostProvider` | Inject a `WhiteboardHost` into the subtree. |
| `useWhiteboardHost()` | Read the host inside any component. |
| `useWhiteboardStore` | zustand store — `byPaper`, current focus, hydration. State only; the host owns I/O. |

### `WhiteboardHost` interface

The renderer↔host contract. 16 methods mirroring the Fathom IPC surface. Two kinds:

- **RPC + per-call callbacks**: `generate(req, cb)`, `expand(req, cb)`, `chatSend(req, cb)`. Per-call lifecycle events (`onPass1Delta`, `onPass1Done`, etc.) flow through `cb`.
- **Event-bus subscriptions**: `onSceneStream(cb)`, `onStep(cb)`, `onCriticVerdict(cb)`. App-wide notifications fired independent of any specific call. Each returns an unsubscribe fn.

See [`src/renderer/host.tsx`](src/renderer/host.tsx) for the full type definition with per-callback shapes.

## Two usage modes

### 1. Node library (pipeline-only)

For CI, batch-paper processing, or any non-interactive use. Import `fathom-whiteboard/pipeline`; supply `PaperIndex` + `onArtifact`; no renderer needed. The render harness in `scripts/` is still spawned by `runPass2` (the in-MCP visual critic uses it) — make sure the package's `scripts/` directory is on the filesystem next to your installed `node_modules/`.

### 2. React component (host wraps both halves)

For an interactive app. Implement `WhiteboardHost` (wrap your IPC / fetch layer); wrap your React tree in `<WhiteboardHostProvider>`; render `<WhiteboardTab>`. The host is responsible for:
- Calling pipeline functions on the Node side when `host.generate(req, cb)` is invoked
- Persisting `PipelineArtifact`s wherever they should live
- Streaming pipeline events back through the per-call callbacks + the 3 lifecycle subscriptions

See `examples/demo/` for a minimal Vite + Node sidecar skeleton.

## See also

- `examples/demo/` — minimal demo app skeleton (pipeline-only flow + React mount). Skeleton only; full implementation is Phase 2.5.
- `docs/methodology.md` — how the pipeline works internally (Pass 1 / Pass 2 / Pass 2.5 / chat refinement, prompt strategies, cost estimates, failure modes).
- [Fathom](https://github.com/ashryaagr/Fathom) — the original integration; reads as the canonical worked example of a `WhiteboardHost`.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Phase 2 is the initial extraction; the package is private during stabilisation. Issues and PRs welcome once the demo (Phase 2.5) lands and the API stabilises.
