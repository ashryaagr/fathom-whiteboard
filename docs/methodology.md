# Whiteboard pipeline methodology

This is how `fathom-whiteboard` turns a research paper into an Excalidraw whiteboard. Plain-language reading order; no source code required.

## TL;DR

```
paper.md ──► Claude (Agent SDK) ──► excalidraw-mcp ──► scene.elements[]
              │
              └─ system prompt = coleam SKILL.md + Fathom suffix
                 allowed tools = read_me + create_view
                 settingSources = []
```

Two tools, one or two turns of agent work, one elements array out.

## The pipeline run

1. **System prompt is built** by concatenating the coleam SKILL.md verbatim with a short Fathom-specific suffix that says "you're explaining a research paper, plan one canvas, call read_me once, call create_view once with the final elements." The SKILL is ~24KB; the suffix is a paragraph.
2. **Paper is the user message.** If the host passes `{ kind: 'text', markdown }` we inline the markdown directly; if `{ kind: 'path' }` we tell Claude where to read it from and allow the `Read` tool too.
3. **MCP transport is connected** as HTTP. Default: hosted endpoint (`https://mcp.excalidraw.com/mcp`). Optional: spawn `vendor/excalidraw-mcp` locally on an OS-assigned port; the launcher tails stdout for the "MCP server listening on …" line and parses out the URL.
4. **`allowedTools`** is set to exactly `mcp__excalidraw__read_me` and `mcp__excalidraw__create_view`. This is the durable filter — the SDK respects `allowedTools` even when other tools would otherwise be enabled. `settingSources: []` ensures no host-side `CLAUDE.md` or user config bleeds into the run.
5. **Stream consumed.** As Claude emits assistant blocks, we record:
   - text deltas (`onAssistantText`, also logged via `onLog`)
   - tool_use events (`onToolUse`, plus `onLog`)
   - the input of every `mcp__excalidraw__create_view` call — the latest one becomes our final scene (`onSceneUpdate` fires per call)
6. **Result event** carries the cost in USD; we surface that in the result + final log line.

That's the whole pipeline.

## Why this shape (vs the pre-pivot version)

The pre-pivot code had Pass 1 (read paper into 1M context, emit a markdown understanding doc), Pass 2 (read the understanding, plan + emit a scene through a custom 9-tool MCP wrapper with templates), Pass 2.5 (render to PNG, vision-critique, iterate up to 3 rounds), and a chat refinement step-loop with its own widened tool surface. It was ~3,000 LOC of pipeline code.

A control experiment — vanilla Agent SDK + unmodified `excalidraw-mcp` + coleam's SKILL — ran the same paper for $0.95 in 3 turns and produced a tighter, more designed-feeling diagram. The shape of the diagram (variety of element types, container/free-floating mix, evidence artefacts) was visibly closer to the SKILL's quality bar than what our elaborate pipeline emitted.

The takeaway: when the upstream MCP + a well-written SKILL are doing the heavy lifting, additional pipeline layers were *suppressing* quality, not adding to it. Templates locked the agent into a small set of layouts; the custom 9-tool wrapper made it harder for the agent to think in plain Excalidraw elements; the visual critic was second-guessing perfectly fine output. So we threw all of it away.

## What's still important

- **The SKILL prompt.** This is doing real work. Read it (`src/SKILL.md`); it's a 24KB design playbook covering the Isomorphism Test, the Education Test, the concept→pattern table, evidence artefacts, the bad-vs-good comparison table, and a 27-item quality checklist. The pipeline's only job is to deliver that playbook intact to the model.
- **`allowedTools` lock-down.** Without it, Claude reaches for built-in tools (`ToolSearch`, `Bash`, `WebFetch`) and the run drifts. The control experiment's first attempt had Claude calling `ToolSearch` instead of doing the work; locking allowedTools fixed it.
- **`settingSources: []`.** When the host has its own `CLAUDE.md` (like Fathom), that file leaks into the run and biases the agent. Empty source list = the system prompt is exactly what we authored.

## Cost profile

End-to-end ReconViaGen paper (62KB markdown), Opus 4.7 via the Agent SDK:
- Generation: ~$0.95, 3 turns, ~104 elements emitted.
- Refinement (per chat turn): ~$0.10–$0.30 depending on how much the agent re-reads.

If you're processing dozens of papers in batch, prefer running on the user's CLI auth (which the SDK uses by default) over a separately-rate-limited API key.

## Failure modes

- **Agent calls `create_view` zero times.** The result has `scene.elements = []`. The host should detect this and either retry once or surface a "couldn't generate" UI. We do not auto-retry inside the pipeline (per Fathom's "no retry logic" principle).
- **Hosted endpoint is unreachable.** `query()` rejects with the underlying network error. Pipeline propagates as-is via `onError` and the rejected promise.
- **Paper is too long.** Opus 4.7 (1M context) handles ~700K tokens of paper before we hit the wall; nothing in the world is that long. The MCP `read_me` reply is small. We do not truncate the paper; the SDK will surface a context-limit error if we ever do exceed it.
- **Agent emits malformed Excalidraw elements.** The `create_view` MCP server validates them and may reject the call; we capture the latest *successful* scene and ignore failed ones. The Excalidraw editor in `Whiteboard.tsx` will render whatever we hand it, so an empty/malformed scene shows as a blank canvas. The host can detect that via `scene.elements.length === 0`.

## Logging

The pipeline emits via `GenerateCallbacks.onLog`:
- `[assistant] <first 200 chars of text block>` — every text block from Claude
- `[tool_use] <name>` — every tool call
- `[result] turns=N usd=X` — final summary

Hosts that wire this to a file get a usable transcript out of the box. The Fathom integration also forwards via `webContents.send` so the renderer log viewer sees every line in real time.

## Persistence

The pipeline does not persist anything. The host's `WhiteboardHost.saveScene` / `loadScene` methods are responsible for that. In Fathom, scenes live in the per-paper sidecar at `~/Library/Application Support/Fathom/sidecars/<contentHash>/whiteboard-scene.json`.

This matches Fathom's CLAUDE.md `§1` rule: "Whiteboards persist by default. Once the user has paid the API cost, regenerating it because we forgot to save is a design failure."
