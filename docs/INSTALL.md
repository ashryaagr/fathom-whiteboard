# Installing Slate

For now: macOS + Claude Code subscription. Windows, Linux, Codex, and Gemini support coming soon.

macOS, Apple Silicon. Two install paths — pick whichever feels natural:

- **Option A — `install.sh`**: `curl | bash`. No Gatekeeper approval, no
  drag. Adds a `slate` terminal launcher. Same app, different wrapper.
- **Option B — DMG**: the familiar drag-to-Applications flow. Requires
  approving the app once via System Settings the first time you launch it.

Both end up as `/Applications/Slate.app`. Both run the same agent
pipeline; both pull updates with the same `install.sh` script.

Both require the Claude Code CLI at runtime — see
[Prerequisites](#3-prerequisites).

- [1. Download Slate](#1-download-slate) — curl or DMG.
- [2. First launch: approve the app](#2-first-launch-approve-the-app) —
  DMG users only. Option A skips this.
- [3. Prerequisites](#3-prerequisites) — Claude Code CLI.
- [4. Build from source](#4-build-from-source) — modify or inspect Slate.
- [5. Embed inside another app](#5-embed-inside-another-app) — npm
  package consumed by your own host.
- [6. Where Slate stores your data](#6-where-slate-stores-your-data)
- [7. Verifying it works](#7-verifying-it-works)

---

## 1. Download Slate

### Option A — `install.sh` (primary)

```bash
curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh | bash
```

That's it. The script:

1. Downloads `Slate-arm64.zip` from the latest GitHub Release.
2. Extracts to `/Applications/Slate.app` (or `~/Applications/` if the
   system directory isn't writable).
3. Clears the `com.apple.quarantine` xattr — Gatekeeper treats the
   bundle as a locally-built app, so **no "Open Anyway" prompt the
   first time you launch**.
4. Re-applies ad-hoc signing so the loader is satisfied.
5. Installs a `slate` launcher at `~/.local/bin/slate`:
   ```bash
   slate                  # launch the app
   slate update           # pull latest (same script runs again)
   slate --version
   slate uninstall
   ```
6. Launches Slate — you land on the welcome screen in one motion.

If `~/.local/bin` isn't already on your `PATH`, the script prints the
one line you need to add to `~/.zshrc` (or `~/.bashrc`).

**Want to read the script before piping it to bash?**

```bash
curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh -o install.sh
less install.sh
bash install.sh
```

The script lives [here in the repo](../install.sh) — about 230 lines.

**Install a specific version:**
```bash
curl -fsSL …/install.sh | bash -s -- --version v0.1.8
```

**Uninstall:**
```bash
slate uninstall
```

### Option B — DMG

If you'd rather drag-to-Applications:

1. **Download** [`Slate-arm64.dmg`](https://github.com/ashryaagr/slate/releases/latest/download/Slate-arm64.dmg).
2. Double-click the DMG to mount it.
3. Drag `Slate.app` onto the **Applications** folder shown in the DMG window.
4. Close the disk image.
5. Open `/Applications/Slate.app`. macOS will block it the first time
   with a "can't be opened because Apple cannot check it" warning —
   that's expected. Continue to
   [Section 2](#2-first-launch-approve-the-app) for the one-time
   approval.

| Architecture | Direct link |
|---|---|
| Apple Silicon (M1 / M2 / M3 / M4) | [Slate-arm64.dmg](https://github.com/ashryaagr/slate/releases/latest/download/Slate-arm64.dmg) |
| Apple Silicon, zipped `.app` | [Slate-arm64.zip](https://github.com/ashryaagr/slate/releases/latest/download/Slate-arm64.zip) |
| Intel | *(build from source; prebuilt x64 lands when demand warrants)* |

Updates are the same one-line re-run of `install.sh` regardless of
which install path you chose.

---

## 2. First launch: approve the app

*Only needed for the DMG path. Option A clears the quarantine xattr
during install so this whole section is bypassed.*

Slate is signed ad-hoc — it's a real, valid signature, but not from an
Apple Developer ID, so on first launch macOS asks you to confirm:

1. Open `/Applications/Slate.app`. macOS shows
   *"Slate.app can't be opened because Apple cannot check it for
   malicious software"*.
2. Click **Done** (the dialog only offers that, by design).
3. Open **System Settings → Privacy & Security**.
4. Scroll to the **Security** section. You'll see:
   *"Slate.app was blocked to protect your Mac"*.
5. Click **Open Anyway** next to that line.
6. macOS prompts for your password (or Touch ID).
7. A second dialog appears — *"macOS cannot verify the developer of
   Slate.app"*. Click **Open**.

After this one-time approval, double-clicking `Slate.app` opens it
normally. Future updates re-use the same approval.

If you'd rather avoid this dance entirely, switch to Option A — it
clears the quarantine xattr at install time, so the first launch is
silent.

---

## 3. Prerequisites

Slate runs the agent through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), which wraps the Claude Code CLI. You need:

- **macOS on Apple Silicon** for the standalone app. (The npm package is platform-agnostic.)
- **Claude Code CLI installed**, with `claude` on your `$PATH`:
  ```bash
  curl -fsSL https://claude.ai/install.sh | sh
  which claude    # should print something like /Users/you/.local/bin/claude
  claude --version
  ```
- **Claude Code signed in.** Slate uses your existing Claude
  subscription via the CLI — no API keys, no accounts inside Slate:
  ```bash
  claude /login
  ```

If `claude` isn't on `$PATH` when Slate launches, the app surfaces a
dialog with the specific command to run. Re-launch and continue.

---

## 4. Build from source

Slate is one repo, one `npm install`. The vendored excalidraw-mcp gets
fetched + built by a postinstall hook:

```bash
git clone https://github.com/ashryaagr/slate.git
cd slate
npm install
npm run app:build
npm run app           # launch in dev mode
```

For a packaged Mac app:

```bash
npm run dist:mac      # → release/Slate-arm64.dmg + release/Slate-arm64.zip
```

Requires Node 22+, macOS 14+, Xcode Command Line Tools.

For HMR / DevTools-attached dev:
```bash
npm run app:dev       # WB_DEVTOOLS=1 — Cmd+Option+I works
```

---

## 5. Embed inside another app

Slate ships as `fathom-whiteboard` on npm — the same component, but as
a React surface you can mount inside your own Electron / web app:

```bash
npm install fathom-whiteboard
```

```tsx
import { Whiteboard, useWhiteboardScene } from 'fathom-whiteboard/react';

const host = {
  generate: (cb) => window.api.generate(cb),
  refine: (scene, instruction, cb) => window.api.refine(scene, instruction, cb),
  loadScene: () => window.api.loadScene(),
  saveScene: (scene) => window.api.saveScene(scene),
};

<Whiteboard host={host} />
```

The host is anything that wires `generate` / `refine` to a Claude
Agent SDK instance. The library doesn't open network sockets, mount
file handles, or assume a specific runtime.

The pipeline (`generateWhiteboard` / `refineWhiteboard`) is also
exported as plain functions if you want to drive it without the React
surface — see [src/pipeline.ts](https://github.com/ashryaagr/slate/blob/main/src/pipeline.ts).

---

## 6. Where Slate stores your data

Slate writes nothing to your home directory other than the per-session
canvas state, kept under:

```
~/Library/Application Support/Slate/sessions/last/
```

Inside it:
- `scene.json` — the live Excalidraw scene (boxes, arrows, edits).
- `paper.json` — the most-recently pasted content + any saved attachments.
- `viewport.json` — last-known scroll/zoom position.

Delete the folder any time to reset Slate. The pasted content is gone;
the app boots into the empty paste-prompt screen.

There is no telemetry, no analytics, no remote logging. Slate doesn't
even check for updates unless you re-run `slate update` (or
`install.sh`) yourself.

---

## 7. Verifying it works

After install:

```bash
slate --version       # prints the installed version, e.g. "0.1.8"
slate                 # launches Slate
```

Inside the app:
1. The paste-prompt screen should be visible — empty canvas, "Paste
   anything…" prompt at the bottom.
2. Paste any short text (e.g. a paper abstract). Press Return.
3. Within 1–2 seconds the activity log shows
   `[tool_use] mcp__excalidraw__create_view` and the canvas starts
   drawing.

If step 3 hangs without progress for more than ~15s, check that
`claude` is on your `$PATH` and signed in (Section 3). The DevTools
console (Cmd+Option+I) prints `[Slate …]` and `[fathom-whiteboard …]`
diagnostic lines for every IPC + agent turn.
