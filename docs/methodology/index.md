---
layout: default
title: Methodology — the clawdSlate pipeline
permalink: /methodology/
---

# Whiteboard pipeline methodology

This is how clawdSlate (and the `fathom-whiteboard` npm package) turns pasted content — a research paper, a slide deck, a code architecture, a screenshot of a meeting whiteboard — into an Excalidraw whiteboard. Plain-language reading order; no source code required.

## TL;DR

```
pasted content ──► Claude (Agent SDK) ──► excalidraw-mcp ──► scene.elements[]
                    │
                    └─ system prompt = coleam SKILL.md + clawdSlate suffix
                       allowed tools = read_me + create_view (+ Read for paths)
                       settingSources = []
```

Two MCP tools, one or two turns of agent work, one elements array out.

## The pipeline run

1. **System prompt is built** by concatenating the coleam SKILL.md verbatim with a short clawdSlate-specific suffix that says "you're explaining a research paper as a teaching whiteboard, plan one canvas, call read_me once, call create_view multiple times so the canvas updates progressively." The SKILL is ~24KB; the suffix is ~70 lines.
2. **Pasted content is the user message.** If the host passes `{ kind: 'text', markdown }` we inline the markdown directly; if `{ kind: 'path' }` we tell Claude where to read it from and allow the `Read` tool too. A `focus` block surfaces the user's optional emphasis ("focus on X") near the top of the message.
3. **MCP transport is connected** as HTTP. Default: hosted endpoint (`https://mcp.excalidraw.com/mcp`). Optional: spawn `vendor/excalidraw-mcp` locally on an OS-assigned port; the launcher tails stdout for the "MCP server listening on …" line and parses out the URL.
4. **`allowedTools`** is set to exactly `mcp__excalidraw__read_me` and `mcp__excalidraw__create_view` (plus `Read` when the paper is a file path). This is the durable filter — the SDK respects `allowedTools` even when other tools would otherwise be enabled. `settingSources: []` ensures no host-side `CLAUDE.md` or user config bleeds into the run.
5. **Stream consumed.** As Claude emits assistant blocks, we record:
   - text deltas (`onAssistantText`, also logged via `onLog`)
   - tool_use events (`onToolUse`, plus `onLog`)
   - the input of every `mcp__excalidraw__create_view` call — `resolveSceneFromInput` applies vendor delta semantics (restoreCheckpoint + delete) and yields the new resolved scene; we fire `onSceneUpdate` so the renderer paints progressively.
6. **Result event** carries the cost in USD; we surface that in the result + final log line.

That's the whole pipeline. The full source is in [`src/pipeline.ts`](https://github.com/ashryaagr/clawdslate/blob/main/src/pipeline.ts) — about 460 lines.

## Why this shape (vs the pre-pivot version)

Pre-pivot (the elaborate version derived from Fathom's whiteboard tab):
- Pass 1 read paper into 1M context, emitted a markdown understanding doc.
- Pass 2 read the understanding, planned + emitted a scene through a custom 9-tool MCP wrapper with templates.
- Pass 2.5 rendered to PNG, vision-critiqued, iterated up to 3 rounds.
- A chat refinement step-loop with its own widened tool surface.

It was ~3,000 LOC of pipeline code.

A control experiment — vanilla Agent SDK + unmodified `excalidraw-mcp` + coleam's SKILL — ran the same paper for $0.95 in 3 turns and produced a tighter, more designed-feeling diagram. The shape of the diagram (variety of element types, container/free-floating mix, evidence artefacts) was visibly closer to the SKILL's quality bar than what our elaborate pipeline emitted.

The takeaway: when the upstream MCP + a well-written SKILL are doing the heavy lifting, additional pipeline layers were *suppressing* quality, not adding to it. Templates locked the agent into a small set of layouts; the custom 9-tool wrapper made it harder for the agent to think in plain Excalidraw elements; the visual critic was second-guessing perfectly fine output. So we threw all of it away.

## What's still important

- **The SKILL prompt.** This is doing real work. Read it (`src/SKILL.md`); it's a 24KB design playbook covering the Isomorphism Test, the Education Test, the concept→pattern table, evidence artefacts, the bad-vs-good comparison table, and a 27-item quality checklist. The pipeline's only job is to deliver that playbook intact to the model.
- **`allowedTools` lock-down.** Without it, Claude reaches for built-in tools (`ToolSearch`, `Bash`, `WebFetch`) and the run drifts. The control experiment's first attempt had Claude calling `ToolSearch` instead of doing the work; locking allowedTools fixed it.
- **`settingSources: []`.** When the host has its own `CLAUDE.md` (like Fathom, which embeds `fathom-whiteboard`), that file leaks into the run and biases the agent. Empty source list = the system prompt is exactly what we authored.
- **`safeAgentCwd()`.** When the SDK runs inside an Electron `app.asar` bundle, the default cwd resolves to a path that `child_process.spawn` reads as ENOTDIR (asar's hook lets Read see it as a dir, but the syscall sees it as a file). clawdSlate picks the user's home directory as a guaranteed-real cwd. This is the canonical reference for the "tools enforce constraints" principle (CLAUDE.md §8): the failure mode wasn't fixable by prompting the agent — it had to be fixed in the layer clawdSlate controls.
- **`resolveSceneFromInput` pseudo-element filtering.** The vendor MCP defines three "pseudo-elements" (`cameraUpdate`, `restoreCheckpoint`, `delete`) that are part of its wire protocol but NOT real Excalidraw element types. Excalidraw's `updateScene` rejects scenes containing them, so the pipeline strips them client-side. Same principle: the layer we control (`resolveSceneFromInput`) handles the wire-protocol mismatch so the renderer sees a clean, fully-resolved scene. The agent doesn't need to know.

## Cost profile

End-to-end ReconViaGen paper (62KB markdown), Opus 4.7 via the Agent SDK:
- Generation: ~$0.95, 3 turns, ~104 elements emitted.
- Refinement (per chat turn): ~$0.10–$0.30 depending on how much the agent re-reads.

If you're processing dozens of papers in batch, prefer running on the user's CLI auth (which the SDK uses by default) over a separately-rate-limited API key.

## Failure modes

- **Agent calls `create_view` zero times.** The result has `scene.elements = []`. The host should detect this and surface a "couldn't generate" UI. We do not auto-retry inside the pipeline (per CLAUDE.md §8 "no retry logic" — a failure once is signal worth reading, not transient noise).
- **Hosted endpoint is unreachable.** `query()` rejects with the underlying network error. Pipeline propagates as-is via `onError` and the rejected promise.
- **Paper is too long.** Opus 4.7 (1M context) handles ~700K tokens of paper before we hit the wall; nothing in the world is that long. The MCP `read_me` reply is small. We do not truncate the paper; the SDK will surface a context-limit error if we ever do exceed it.
- **Agent emits malformed Excalidraw elements.** The `create_view` MCP server validates them and may reject the call; we capture the latest *successful* scene and ignore failed ones. The Excalidraw editor in `Whiteboard.tsx` will render whatever we hand it, so an empty/malformed scene shows as a blank canvas. The host can detect that via `scene.elements.length === 0`.
- **`spawn ENOTDIR` (historical).** Symptom of the Electron-asar cwd bug. clawdSlate's `safeAgentCwd()` plus `electron-builder.config.cjs`'s `asarUnpack` for the vendor binary prevent this. If it returns, check both fixes are still in place (see `clawdslate-qa.md` S3).

## Logging

The pipeline emits via `GenerateCallbacks.onLog`:
- `[system] init model=… tools=…` — the agent SDK's init event.
- `[assistant] <first 200 chars of text block>` — every text block from Claude.
- `[tool_use] <name> id=… input=…` — every tool call.
- `[tool_result] id=… …` — every tool result threaded back as a user message.
- `[result] turns=N usd=X` — final summary.
- `[aborted] run cancelled by caller` — clean abort path.

Hosts that wire this to a file get a usable transcript out of the box. clawdSlate's Electron host forwards via `webContents.send` so the renderer log viewer sees every line in real time. Embedded hosts (e.g. Fathom) wire it to their own log surface.

## Persistence

The pipeline does not persist anything. The host's `WhiteboardHost.saveScene` / `loadScene` methods are responsible for that.

In clawdSlate, scenes live in the per-session sidecar at:

```
~/Library/Application Support/clawdSlate/sessions/last/
  whiteboard.excalidraw           — full Excalidraw scene file
  whiteboard.viewport.json        — last-known scrollX/scrollY/zoom
  paper.json                      — most recent pasted content
  assets/                         — saved attachments (images, PDFs)
```

This matches CLAUDE.md §1 "Persist by default": once the user has paid the API cost (~$0.95) to generate a whiteboard, regenerating it because clawdSlate forgot to save is a design failure. On reopen, the renderer hydrates from disk first, regenerates only if no saved state exists. The ONLY paths to deletion are: (a) the user explicitly clicks "Clear" / "Regenerate"; (b) the user manually deletes the session dir.

## Embedded host: how Fathom uses this

Fathom's per-paper "Whiteboard" tab embeds `<Whiteboard>` from this same npm package. Fathom's host implementation:

- `loadScene` reads from Fathom's per-paper sidecar
  (`~/Library/Application Support/Fathom/sidecars/<contentHash>/whiteboard-scene.json`).
- `saveScene` writes to the same path.
- `generate` invokes Fathom's main-process `whiteboard:generate`
  IPC, which calls `generateWhiteboard` from this package against
  the indexed paper's content.
- `refine` invokes Fathom's `whiteboard:refine` IPC with the
  current scene + instruction.

The pipeline is identical in both cases — clawdSlate and Fathom run the same `generateWhiteboard` against the same MCP. The host's only job is to wire `loadScene`/`saveScene` to its own persistence and `generate`/`refine` to a streaming IPC. See `WhiteboardHost` in [`src/Whiteboard.tsx`](https://github.com/ashryaagr/clawdslate/blob/main/src/Whiteboard.tsx) for the contract.
