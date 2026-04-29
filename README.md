# fathom-whiteboard

Generate explanatory whiteboards from research papers using the Claude Agent SDK + the upstream `excalidraw-mcp` server + the `coleam00/excalidraw-diagram-skill` SKILL prompt.

A research paper goes in. A teaching whiteboard comes out. A chat input lets the user refine it.

That's the whole thing.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Host app (Fathom, demo, anything)                        │
│                                                          │
│   <Whiteboard host={…} />          generateWhiteboard()  │
│   ─ Excalidraw editor              ─ Claude Agent SDK    │
│   ─ chat input                     ─ MCP HTTP transport  │
│   ─ persistence via host           ─ system prompt =     │
│                                       coleam SKILL.md +  │
│                                       Fathom suffix      │
│                                                          │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ excalidraw-mcp           │
                │ (hosted or local)        │
                │  ─ read_me               │
                │  ─ create_view           │
                └──────────────────────────┘
```

Two MCP tools, two pipeline calls (`generateWhiteboard`, `refineWhiteboard`), one React component (`Whiteboard`). No templates, no Pass 1/2/2.5 split, no critic loop, no DSL, no ELK layout, no custom MCP wrapper.

## Why this shape

We tried the elaborate version first (multi-pass pipeline, custom MCP wrapper with 9 placement tools, template library, visual critic loop). A control experiment — vanilla Agent SDK + the unmodified upstream `excalidraw-mcp` + coleam's SKILL prompt — produced a tighter, more designed-feeling diagram on the same paper for a fraction of the code. So we threw out the elaborate version and aligned on the control.

The pre-pivot code lives in `old/` (locally only — gitignored).

## Install

```bash
npm install fathom-whiteboard
# or, sibling-clone in a monorepo:
# "fathom-whiteboard": "file:../fathom-whiteboard"
```

You will also need the Claude CLI installed and authenticated (`claude /login`). The SDK wraps the CLI.

## Pipeline (Node)

```ts
import { generateWhiteboard, refineWhiteboard } from 'fathom-whiteboard';

const { scene, usd } = await generateWhiteboard(
  { kind: 'text', markdown: paperMarkdown, title: 'ReconViaGen' },
  {
    onLog: (line) => console.log(line),
    onSceneUpdate: (s) => console.log('scene now', s.elements.length, 'elements'),
  },
);
// scene.elements is the Excalidraw elements array. Persist it however you like.

const { scene: refined } = await refineWhiteboard(
  scene,
  { kind: 'text', markdown: paperMarkdown, title: 'ReconViaGen' },
  'Add the loss equation under the training loop',
);
```

The pipeline:

1. Hands the SKILL.md prompt + Fathom suffix to Claude as the system prompt.
2. Hands the paper as the user message.
3. Connects an HTTP MCP transport to `excalidraw-mcp` (default: hosted at `https://mcp.excalidraw.com/mcp`).
4. Allows exactly two tools — `mcp__excalidraw__read_me` and `mcp__excalidraw__create_view`.
5. Captures the elements JSON from the last `create_view` call.

`settingSources: []` is set so the pipeline ignores any `CLAUDE.md` / project / user config the host might have lying around — it runs with exactly the prompt we authored.

## Renderer (React)

```tsx
import { Whiteboard } from 'fathom-whiteboard';
import type { WhiteboardHost } from 'fathom-whiteboard';

const host: WhiteboardHost = {
  loadScene: () => myIpc.invoke('whiteboard:get'),
  saveScene: (scene) => myIpc.invoke('whiteboard:save', scene),
  generate: (cb) => myIpc.streamingInvoke('whiteboard:generate', cb),
  refine: (scene, instruction, cb) =>
    myIpc.streamingInvoke('whiteboard:refine', { scene, instruction }, cb),
};

<Whiteboard host={host} />
```

The component:
- On mount, calls `host.loadScene()`. If a scene exists, displays it.
- If none and `autoGenerate` (default true), calls `host.generate()` and persists the result via `host.saveScene()`.
- The chat input at the bottom calls `host.refine(currentScene, instruction)` and persists the result.

The host is responsible for transporting the streaming events from your Node process to the renderer. In Electron, that's `ipcRenderer.invoke` + `webContents.send`; the Fathom integration uses the existing `runStreamingIpcHandler` helper for this.

## MCP server: hosted vs local

By default the pipeline points at the hosted endpoint (`https://mcp.excalidraw.com/mcp`). This matches the control experiment that produced the design we're aligning to. Zero local build.

To run locally instead:
```bash
cd vendor/excalidraw-mcp
pnpm install && pnpm run build
```
Then in your code:
```ts
import { spawnLocalMcp } from 'fathom-whiteboard';
const handle = await spawnLocalMcp();
// pass { kind: 'local', spawn: () => Promise.resolve(handle) } to generateWhiteboard
```

`vendor/` is gitignored; it's a developer convenience, not a published artefact.

## Cost

The control experiment ran the ReconViaGen paper end-to-end for **~$0.95** in 3 turns. Refinement turns are cheaper (~$0.10–$0.30) because the paper is smaller per call.

Standing user approval covers this for the Fathom whiteboard pipeline; document any new cost profile (different model, much larger paper) before first use.

## Repo layout

```
src/
  index.ts            re-exports the public surface
  pipeline.ts         generateWhiteboard, refineWhiteboard
  Whiteboard.tsx      React component + WhiteboardHost interface
  mcp-launcher.ts     resolveHosted, spawnLocalMcp
  skill.ts            COLEAM_SKILL constant (verbatim coleam SKILL.md)
  SKILL.md            source-of-truth copy of the SKILL
  types.ts            shared types
docs/
  methodology.md      how the pipeline works
vendor/excalidraw-mcp gitignored; clone the upstream MCP server here for local mode
old/                  pre-pivot code; gitignored, kept locally for reference
```

## License

MIT — see [LICENSE](LICENSE).
