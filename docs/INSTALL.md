# Installing Slate

macOS, Apple Silicon. Slate ships as an unsigned indie app — there's no Apple Developer ID involved — so the first launch needs a one-time approval.

- [1. Download Slate](#1-download-slate)
- [2. First launch: approve the app](#2-first-launch-approve-the-app)
- [3. Prerequisites](#3-prerequisites)
- [4. Build from source](#4-build-from-source)
- [5. Embed inside another app](#5-embed-inside-another-app)
- [6. Where Slate stores your data](#6-where-slate-stores-your-data)
- [7. Verifying it works](#7-verifying-it-works)

---

## 1. Download Slate

| Architecture | Download |
|---|---|
| Apple Silicon (M1 / M2 / M3 / M4), DMG | [Slate-arm64.dmg](https://github.com/ashryaagr/fathom-whiteboard/releases/latest/download/Slate-arm64.dmg) |
| Apple Silicon, zipped `.app` | [Slate-arm64.zip](https://github.com/ashryaagr/fathom-whiteboard/releases/latest/download/Slate-arm64.zip) |
| Intel | *(build from source — see section 4)* |

**DMG path:** double-click → drag `Slate.app` to the `Applications` folder shown in the disk-image window → close the disk image.

**Zip path:** double-click `Slate-arm64.zip` in Finder → drag the resulting `Slate.app` into `/Applications`.

Both end up at `/Applications/Slate.app`.

## 2. First launch: approve the app

Slate is ad-hoc-signed, not Apple-signed. The first time you launch, macOS will block it with a *"Slate.app can't be opened because Apple cannot check it for malicious software"* warning.

This is expected — there's no malware involved, just an indie developer who hasn't paid for an Apple Developer ID. The bundle is the same `.app` you'd get if you built from source. To approve:

1. Right-click `Slate.app` in `/Applications` → **Open**.
2. macOS shows a slightly different dialog with an **Open** button. Click it.
3. Slate launches. From now on, double-clicking works normally.

If you'd rather verify the bundle's signature first:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Slate.app
# Should print: "valid on disk; satisfies its Designated Requirement"
```

## 3. Prerequisites

Slate runs the agent through Anthropic's [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), which spawns the Claude Code CLI as a subprocess. You need:

- [ ] **Claude Code CLI installed**, with `claude` on your `$PATH`.
   ```bash
   curl -fsSL https://claude.ai/install.sh | sh
   which claude    # should print something like /Users/you/.local/bin/claude
   claude --version
   ```
- [ ] **Claude Code signed in.** Slate uses your existing Claude subscription — no API keys.
   ```bash
   claude /login   # opens a browser-based sign-in flow
   ```

If `claude` isn't on `$PATH` when Slate launches, the app surfaces the exact command to run. Re-launch and continue.

## 4. Build from source

```bash
git clone https://github.com/ashryaagr/fathom-whiteboard.git
cd fathom-whiteboard
npm install
npm run app:build         # bundles Electron entry + renderer to app/dist/
npm run app               # launch in dev mode
npm run dist:mac          # produce release/Slate-arm64.{dmg,zip}
```

The `dist:mac` script builds the same DMG + zip pair that ships on GitHub Releases. The output lands in `release/` (not `dist/`, which is the npm library output).

If you only want the npm library (for embedding inside another app):

```bash
npm install
npm run build             # produces dist/ — the published npm payload
```

## 5. Embed inside another app

Slate's pipeline + React component ship as `fathom-whiteboard` on npm:

```bash
npm install fathom-whiteboard
```

```ts
import { generateWhiteboard, refineWhiteboard } from 'fathom-whiteboard';
import { Whiteboard, type WhiteboardHost } from 'fathom-whiteboard/react';
```

The host provides four methods (`loadScene`, `saveScene`, `generate`, `refine`) and the component handles canvas rendering, chat input, persistence wiring, and the streaming render. Full host-contract documentation is in [`src/Whiteboard.tsx`](../src/Whiteboard.tsx) — search for `WhiteboardHost`.

[Fathom](https://github.com/ashryaagr/Fathom)'s in-paper whiteboard tab uses exactly this contract, threading the events from a Node main process through an `ipcRenderer.invoke` + `webContents.send` pair. The Slate Mac app uses the same component with a thinner host that reads/writes a single per-session canvas file.

## 6. Where Slate stores your data

```
~/Library/Application Support/Slate/
└── sessions/
    └── last/
        ├── whiteboard.excalidraw     ← the persisted canvas
        ├── whiteboard.viewport.json  ← scroll + zoom restoration
        ├── paper.json                ← the most recent pasted content
        └── assets/                   ← pasted images and PDFs
```

Delete the `sessions/last/` directory at any time to wipe state without uninstalling.

Slate does not write anywhere else. There's no global config, no telemetry log, no analytics file.

## 7. Verifying it works

After install, launch Slate. You should see:

- An empty canvas with a chat input at the bottom.
- A status indicator that turns amber while the agent is drawing.
- The `?` button reveals shortcuts and gestures.

Quick smoke test: paste a paragraph from any paper or article into the chat. The first agent turn typically completes in 30–60 seconds and produces a 50–150-element scene.

If it doesn't work:

```bash
# Check the Electron log (DevTools → Console while Slate is running)
# Look for [Slate …] or [fathom-whiteboard …] lines.

# Verify Claude Code:
claude --version
claude /login

# Verify Slate signature:
codesign --verify --deep --strict /Applications/Slate.app
```

If you're stuck, [open an issue](https://github.com/ashryaagr/fathom-whiteboard/issues) with the relevant log lines — every subsystem emits a prefix so the failing stage is identifiable from log alone.
