---
name: slate-qa
description: How Claude Code does QA on a paste-driven, canvas-based Mac app. A tiered pipeline — cheap checks first, vision/CUA only when necessary — and the canonical pre-release flow to run before every release.
type: skill
---

# Slate QA

Slate is a visual app: paste anything, watch the agent draw on a
live Excalidraw canvas, edit alongside, refine via chat. CLI test
harnesses can only reach part of it; the rest is pixels, animation,
and feel. This skill is the playbook for doing real QA as an agent
on a machine where a human isn't watching.

## When to use

- **Before every release.** Run the canonical flow end-to-end. No
  release declared done until this passes and the log is clean.
- **After any change** to: the paste flow, the agent pipeline, the
  Whiteboard component, persistence (scene/paper/viewport), the
  install/update path, or anything the user interacts with.
- **When a user reports a symptom** — reproduce it under the
  harness first, then fix. Do not blind-patch from description.

## The pyramid

Fastest, cheapest check first. Escalate only when a lower tier
can't answer the question.

```
          ┌──────────────────────────────┐
          │  Computer use (manual feel)  │  Rare
          ├──────────────────────────────┤
          │  Video + frame sampling      │  Animation bugs
          ├──────────────────────────────┤
          │  Screenshots + vision grade  │  Visual correctness
          ├──────────────────────────────┤
          │  IPC state + DevTools log    │  State correctness
          ├──────────────────────────────┤
          │  typecheck + dist-smoke      │  Logic + types + bundle
          └──────────────────────────────┘
```

80% of bugs are catchable in the bottom two tiers. Reserve the
top tiers for what only eyes can see.

### Tier 1 — typecheck + dist smoke (always run first)

```bash
npm run typecheck
scripts/dist-smoke.sh   # if available; otherwise: npm run dist:mac && open release/*.dmg
```

Free, seconds-to-minute, catches half of all regressions before
they even ship to the harness. **Never commit without a clean
typecheck.** Never declare a release done without a clean
dist-smoke run.

### Tier 2 — IPC state + DevTools log

Two substrates:

1. **DevTools console + main-process stdout.** Slate emits
   `[Slate …]` (main + preload) and `[fathom-whiteboard …]`
   (pipeline) lines for every IPC + agent turn. After every
   harness command:

   ```bash
   # Main-process logs land in stdout/stderr of the launched Slate;
   # capture by launching with --enable-logging or via the dev path.
   # Renderer logs surface in DevTools (Cmd+Option+I).
   ```

   In the running app (DevTools attached):
   - `[assistant] <first 200 chars>` — every text block from Claude.
   - `[tool_use] mcp__excalidraw__create_view input=…` — every
     `create_view` call (this is the load-bearing one).
   - `[tool_use] mcp__excalidraw__read_me` — initial canvas read.
   - `[result] turns=N usd=X` — final summary.

2. **Persisted state on disk.**
   ```bash
   ls "$HOME/Library/Application Support/Slate/sessions/last/"
   #   whiteboard.excalidraw
   #   whiteboard.viewport.json
   #   paper.json
   #   assets/
   ```
   These survive app restart by design. After a generate run,
   confirm `whiteboard.excalidraw` exists and contains
   `elements: [...]` with non-zero length.

### Tier 3 — screenshot + vision grade

Not pixel-diff against a golden image — vision-grade against a
short *description*. More forgiving of cosmetic drift; strict
about structural correctness.

```bash
screencapture -x /tmp/slate-shots/welcome.png
```

Then read that file path and grade it yourself. Good expectation
phrasings:

- ✓ "A light-grey window with the Slate wordmark in handwritten
  type at the top, a paste-prompt input at the bottom, and an
  empty canvas in between."
- ✗ "Looks right."  *(too vague; grade nothing)*

For the canvas itself (after a generate run): vision-grade
against the rubric in `.claude/critics/whiteboard.md`.

### Tier 4 — video + frame sampling

For streaming animations (canvas updating as the agent emits
elements, refinement applying mid-stream), static screenshots
miss the frames where the animation matters. Use
`screencapture -v` to record a short clip:

```bash
screencapture -v -R 0,0,1280,880 -T 0 /tmp/slate-stream.mov
# ... paste content, hit return, watch the canvas stream ...
# Ctrl+C to stop

# Sample frames with ffmpeg, then read
ffmpeg -i /tmp/slate-stream.mov -vf fps=10 /tmp/frames/f-%03d.png
```

Read the frames in sequence; confirm the animation beats happen
in the right order (paste → activity log shows
`[tool_use] mcp__excalidraw__read_me` → first
`mcp__excalidraw__create_view` → canvas updates → subsequent
`create_view` calls extend the canvas → final scene lands).

### Tier 5 — computer use (only when the above can't tell)

If a bug is "feels bad" or "something's off" and the structural
checks all pass, escalate to CUA-style manual driving. Reserve
for novel UX judgement, not routine regression.

## Pre-claim verification: the dist bundle is up to date

(Established 2026-04-27 in Fathom after a string of "the fix is live, but
still broken" reports — applies equally to Slate. Multiple agent claims
of "main edit landed" were factually wrong because the running dev
Electron was executing a fossilized bundle from session start.)

When ANY agent claims a main-process or pipeline edit is live in dev,
the QA harness MUST verify by reading `app/dist/main.js` (or
`dist/index.js` for pipeline edits) mtime via:

```bash
stat -f '%Sm %N' app/dist/main.js app/main.ts
# or for a pipeline edit:
stat -f '%Sm %N' dist/index.js src/pipeline.ts
```

The bundle's mtime MUST be **newer** than the source file's mtime. If
the bundle is older, the edit is NOT live regardless of any agent's
confidence.

### Why this matters in Slate

Slate's `npm run app` script runs `npm run app:build` first
(`app/build.mjs`), which esbuild-bundles `app/main.ts → app/dist/main.js`
and the renderer. There is no live `--watch` mode in the current
scripts (as of 2026-04-30), so a code edit *requires* a re-run of
`app:build` to take effect. Confirm via mtime before any Tier 2-5
grade against the running app.

The `dist/` folder (the npm package output) is built by `tsc`. Same
mtime check applies for changes to `src/pipeline.ts`, `src/Whiteboard.tsx`,
`src/skill.ts`, etc.

### Concrete pattern

```bash
# 1. Pre-flight: bundle is newer than every recently-edited source file
SOURCE_MTIME=$(stat -f '%m' src/pipeline.ts)
BUNDLE_MTIME=$(stat -f '%m' dist/index.js)
if [ "$BUNDLE_MTIME" -lt "$SOURCE_MTIME" ]; then
  echo "FAIL: bundle older than source; pipeline fix NOT live"
  exit 1
fi
# 2. Now safe to run Tier 2-5 grading.
```

## The canonical pre-release flow

Run every single step before shipping a release. Each step has
a screenshot + log grep + state assertion.

```bash
# 0. Setup — isolated test instance, never the user's live app
TEST_USER_DATA="/tmp/slate-test-$(date +%s)"
rm -rf "$TEST_USER_DATA"
# (if Slate supports --user-data-dir override directly via Electron flag,
# pass it; otherwise launch a separately-built test build that points
# app.setPath('userData', TEST_USER_DATA) at startup)
open -a Slate --args --user-data-dir="$TEST_USER_DATA"
sleep 3

# 1. Welcome / paste-prompt
screencapture -x /tmp/slate-shots/01-welcome.png
# Expect: "Slate" wordmark in handwriting at the top, empty canvas,
# paste-prompt visible at the bottom.

# 2. Paste a sample paper abstract via clipboard
pbcopy < samples/abstract.txt
osascript -e 'tell application "System Events" to keystroke "v" using {command down}'
sleep 1
osascript -e 'tell application "System Events" to key code 36'  # Return
sleep 5
screencapture -x /tmp/slate-shots/02-streaming.png
# Expect: activity log showing [tool_use] mcp__excalidraw__read_me,
# canvas beginning to draw.

# 3. Wait for the stream to finish
sleep 60
screencapture -x /tmp/slate-shots/03-canvas-final.png
# Expect: canvas with completed diagram, activity log shows
# [result] turns=N usd=X.

# 4. Inspect persisted scene
SCENE="$TEST_USER_DATA/sessions/last/whiteboard.excalidraw"
test -f "$SCENE" || echo "FAIL: scene not persisted"
node -e "console.log(JSON.parse(require('fs').readFileSync('$SCENE','utf8')).elements.length)"
# Expect: > 0

# 5. Refinement — type into chat, observe canvas update
osascript -e 'tell application "System Events" to keystroke "add the loss equation under the training loop"'
osascript -e 'tell application "System Events" to key code 36'  # Return
sleep 30
screencapture -x /tmp/slate-shots/04-refined.png
# Expect: canvas updated with the requested addition, scene file
# regrown.

# 6. Restart and verify persistence
pkill -x Slate
sleep 2
open -a Slate --args --user-data-dir="$TEST_USER_DATA"
sleep 4
screencapture -x /tmp/slate-shots/05-restored.png
# Expect: same canvas as step 5 — scene + viewport restored.

# 7. Final clean-log check (DevTools must be open during the run)
# Look for: zero React error boundary trips, zero "spawn ENOTDIR",
# zero "[error]" lines, zero "Maximum update depth exceeded".

# 8. Cleanup
pkill -x Slate
rm -rf "$TEST_USER_DATA"
```

If any step fails, **do not ship the release**. The bug is real
and the user will hit it.

### Persistence regression check (mandatory — this regresses frequently)

The "scene survives restart" bug class is one of Slate's most
load-bearing invariants (CLAUDE.md §1: "Persist by default. Once
the user has paid the API cost to generate a whiteboard,
regenerating it because Slate forgot to save is a design
failure"). Step 6 above is the permanent trip-wire — if it fails,
ship is blocked regardless of how clean the rest of the flow is.

Concrete failure modes this catches:
- `saveScene` throws silently and `scene.json` is empty after
  generation.
- The hydration loop in `app/main.ts::loadScene` returns null
  even though the file exists (parse error, schema drift).
- The renderer mounts with `elements: []` instead of the loaded
  scene (race between hydration and first render).

## Reading a screenshot — how to vision-grade

1. Read the file with the Read tool (vision layer parses it).
2. State what you expect in one or two concrete sentences.
3. Compare. Don't just say "looks right" — state the structural
   facts you see. "Slate wordmark visible top-left, paste-prompt
   bottom, canvas centred."
4. Flag any of these categories of failure:
   - Missing element (no canvas where there should be)
   - Wrong text (placeholder says "Ask Slate" when spec says "Paste anything")
   - Wrong font (handwritten where it should be sans, or vice
     versa — see `slate-communication.md` for the policy)
   - Layout overflow (canvas clipped, chat input cut off)
   - Wrong state (paste-prompt visible when canvas should be drawn)
   - Visible error card (ErrorBoundary fallback)
   - Pasted content lost (the markdown the user pasted no longer
     visible / persisted)

## Simulating missing prerequisites

Slate needs Claude Code installed + signed in. Users will hit the
failure path when one of those is missing. The canonical flow tests
the happy path — but the failure paths need coverage too, because
that's what a first-time user on a clean machine sees.

Three scenarios to rehearse per release:

### S1. `claude` not on PATH

Simulate by shadowing the binary for the session:

```bash
# Launch Slate with /usr/bin:/bin:/sbin only, hiding every .local/bin
# or Homebrew path where claude normally sits. This is what Slate
# will see for a user who never installed Claude Code.
env PATH=/usr/bin:/bin:/sbin open -gj -a Slate
```

Expected: a dialog or visible status message on first generate
attempt citing "Claude Code not found" with a copy-paste install
command. Log line in DevTools: agent SDK error containing
"claude" + "not found".

### S2. `claude` on PATH but not signed in

Simulate by renaming the auth cache:

```bash
mv ~/.config/claude ~/.config/claude.bak 2>/dev/null || true
mv ~/.claude ~/.claude.bak 2>/dev/null || true
open -gj -a Slate
# after the test:
mv ~/.claude.bak ~/.claude 2>/dev/null || true
mv ~/.config/claude.bak ~/.config/claude 2>/dev/null || true
```

Expected: the app launches, paste-prompt shows, but any generate
triggers an SDK auth-error in the log. The renderer should
surface the `claude /login` remedy.

### S3. asar / ENOTDIR (the historical regression)

The `spawn ENOTDIR` failure mode comes from the Agent SDK's cwd
defaulting to a path inside `app.asar`. Slate's pipeline picks a
guaranteed-real cwd via `safeAgentCwd()` (homedir → '/'), and
`asarUnpack` in `electron-builder.config.cjs` ensures the vendor
binary is not inside asar. Test:

```bash
# Open a fresh release/Slate-arm64.app and confirm a generate run
# completes without "spawn ENOTDIR" or "asar" in the DevTools error
# log.
```

If `spawn ENOTDIR` reappears: check `safeAgentCwd()` is still in
`src/pipeline.ts` and `electron-builder.config.cjs` still has
`asarUnpack` for the vendor MCP binary.

**Rule**: every prerequisite Slate depends on gets one of these
scenarios before shipping a release. New prerequisite added? Add its
matching S-entry here, and fail any release that hasn't rehearsed
the scenario.

## What the harness can't answer (yet)

- **Trackpad gestures inside the canvas.** Excalidraw handles
  pinch/zoom natively; we don't synthesise them. Visual grading
  against screenshots is the workaround.
- **Audio/haptic feedback.** We don't use either, so moot.
- **Scroll inertia feel.** Screenshots + log won't surface this;
  escalate to video sampling.

## Pitfalls to avoid

- **"I ran the flow once and it passed" ≠ "shipped safely."** Run
  twice in a row with a fresh `TEST_USER_DATA` between. Flakiness
  surfaces on the second pass.
- **Don't skip the final log grep.** A test can visually pass
  while the log is littered with ErrorBoundary trips or
  agent-SDK errors that will hit the user in production.
- **Don't tune the harness to the bug you're chasing.** The
  canonical flow is a regression net. Add new steps for new
  features; don't mutate steps for today's bug.
- **Always read the screenshots.** It's tempting to declare
  success when the harness commands don't fail. The commands
  succeed even if the app renders a white screen — that's the
  whole category of bug this skill exists to catch.
