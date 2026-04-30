---
name: slate-e2e-test
description: End-to-end test the packaged Slate.app via paste, keyboard, and screenshots, without a human at the trackpad. Use when verifying a feature works, reproducing a user-reported bug, or before calling a task done.
type: skill
---

# Slate end-to-end test harness

Slate is a desktop Mac app whose core interaction is **paste content,
hit return, watch the agent draw, refine via chat**. The whole flow
is keyboard-reachable, so a computer-use agent can drive it via
`osascript` (AppleScript) + `pbcopy` + `screencapture` even without a
trackpad. This skill is the playbook.

## When to use this skill

- The user reports a bug ("paste didn't trigger generate", "the
  refinement froze the canvas").
- You just finished a change that touches the pipeline, the canvas,
  or any visible UI surface.
- You want to verify a `slate-release.md` build hasn't regressed
  the golden path.

## The harness

Slate doesn't ship a dedicated `fathom-test.sh` equivalent yet. The
existing scaffolding is:

- `scripts/dist-smoke.sh` — currently being added; runs `dist:mac`
  and confirms the output bundle is launchable.
- `npm run app` — launches Slate in dev mode (esbuild bundle of
  `app/main.ts`, then `electron app/dist/main.js`).
- `npm run app:dev` — same but with `WB_DEVTOOLS=1` so DevTools
  attaches.

The harness commands you'll actually use:

```bash
# Lifecycle
pkill -x Slate                                # kill running instance
open -a Slate                                 # launch packaged Slate
open -a Slate --args --user-data-dir=/tmp/slate-test  # isolated test dir

# Pixels
screencapture -x /tmp/slate-shots/<name>.png  # full-screen capture
screencapture -x -R x,y,w,h /tmp/slate-shots/<name>.png  # region

# Direct controls (via AppleScript)
osascript -e 'tell application "System Events" to keystroke "v" using {command down}'  # ⌘V
osascript -e 'tell application "System Events" to key code 36'                          # Return
osascript -e 'tell application "System Events" to key code 53'                          # Esc
osascript -e 'tell application "System Events" to keystroke "n" using {command down}'   # ⌘N

# Clipboard preload
echo "your test content" | pbcopy
pbcopy < /path/to/sample-abstract.txt
osascript -e 'set the clipboard to (read POSIX file "/path/to/sample.png" as JPEG picture)'
```

For programmatic IPC (when AppleScript isn't expressive enough),
launch with `--remote-debugging-port=9222` and drive via the
Chrome DevTools Protocol.

## Canonical end-to-end test loop

Run this before declaring any non-trivial change done.

```bash
# 1. Clean slate (literally) — isolated test user-data dir
TEST_DIR="/tmp/slate-test-$(date +%s)"
rm -rf "$TEST_DIR"
pkill -x Slate || true
open -a Slate --args --user-data-dir="$TEST_DIR"
sleep 3
screencapture -x /tmp/slate-shots/01-welcome.png
# Expect: empty canvas with paste prompt visible at the bottom.

# 2. Paste a sample abstract via clipboard + ⌘V
pbcopy < samples/abstract.txt   # ~2KB markdown
osascript -e 'tell application "System Events" to keystroke "v" using {command down}'
sleep 1
screencapture -x /tmp/slate-shots/02-pasted.png
# Expect: paste prompt now showing the pasted content (or an indicator
# that content is queued); chat input ready.

# 3. Submit the generate run
osascript -e 'tell application "System Events" to key code 36'  # Return
sleep 5
screencapture -x /tmp/slate-shots/03-streaming.png
# Expect: activity log showing [tool_use] mcp__excalidraw__read_me;
# canvas beginning to render; "abort" button visible.

# 4. Wait for generation to finish (~60s for a small abstract)
sleep 60
screencapture -x /tmp/slate-shots/04-done.png
# Expect: canvas with completed diagram, activity log shows
# [result] turns=N usd=X. Chat input is editable (no frozen-UI).

# 5. Type a refinement
osascript -e 'tell application "System Events" to keystroke "make the loss equation a key callout"'
osascript -e 'tell application "System Events" to key code 36'  # Return
sleep 30
screencapture -x /tmp/slate-shots/05-refined.png
# Expect: canvas updated with the requested change; new activity-log
# entries; scene file regrown on disk.

# 6. Inspect persisted state
SCENE="$TEST_DIR/sessions/last/whiteboard.excalidraw"
test -f "$SCENE" || echo "FAIL: scene not persisted"
node -e "
const s = JSON.parse(require('fs').readFileSync('$SCENE','utf8'));
console.log('elements:', s.elements.length);
"
# Expect: > 0 elements

# 7. Restart and verify persistence
pkill -x Slate
sleep 2
open -a Slate --args --user-data-dir="$TEST_DIR"
sleep 4
screencapture -x /tmp/slate-shots/07-restored.png
# Expect: same canvas as 05-refined (CLAUDE.md §1 "Persist by default").

# 8. Cleanup
pkill -x Slate
rm -rf "$TEST_DIR"
```

## Abort flow (separate test — covers the no-frozen-UI principle)

```bash
# Reset
TEST_DIR="/tmp/slate-test-abort-$(date +%s)"
open -a Slate --args --user-data-dir="$TEST_DIR"
sleep 3

# Paste long content (something the agent will spend 60s on)
pbcopy < samples/long-paper.md
osascript -e 'tell application "System Events" to keystroke "v" using {command down}'
sleep 1
osascript -e 'tell application "System Events" to key code 36'  # Return

# Confirm chat input is editable mid-stream (CLAUDE.md §2)
sleep 10
osascript -e 'tell application "System Events" to keystroke "this is a refinement queued mid-run"'
screencapture -x /tmp/slate-shots/abort-01-typed-during-stream.png
# Expect: typed text visible in input — NOT frozen.

# Abort
osascript -e 'tell application "System Events" to key code 53'  # Esc
sleep 2
screencapture -x /tmp/slate-shots/abort-02-aborted.png
# Expect: activity log shows [aborted] run cancelled by caller;
# whatever scene the agent had partially produced is preserved.

# Cleanup
pkill -x Slate
rm -rf "$TEST_DIR"
```

If any step shows a frozen input, an empty canvas after a
non-aborted run, no abort response, or an error in the DevTools
log — that's the test failing. Report the specific screenshot and
log line, don't just say "it didn't work".

## What to Read vs what to screenshot

- Screenshots (`.png` under `/tmp/slate-shots/`): use `Read` on the
  file path — the vision layer can parse the UI state.
- Logs: capture lines prefixed `[Slate …]`, `[fathom-whiteboard …]`,
  `[assistant]`, `[tool_use]`, `[result]`. Most failures log a root
  cause before the user-visible symptom.

To capture the running app's logs, the cleanest path is the
in-app activity log (visible in the renderer) plus DevTools
console (Cmd+Option+I, or launch with `WB_DEVTOOLS=1` env).

## Things you can't test this way

- Trackpad pinch-zoom on the canvas. Excalidraw handles this
  natively; the keyboard path uses `+`/`-` for zoom, which the
  test harness CAN drive.
- Animation timing precisely. Screenshots are point-in-time; use
  multiple with `sleep` between them if animation correctness
  matters. For streaming animations, prefer a `screencapture -v`
  recording + ffmpeg frame-sample.
- Any audio or haptic feedback (Slate uses neither).

## Before finishing

Every test loop should end with:

```bash
# Confirm no React error boundary trips, no spawn-ENOTDIR, no
# unhandled rejection in the captured DevTools log.
# (Capture varies by how you launched — adjust to your setup.)
```

Clean log + the final screenshot matching the expected state =
pass.
