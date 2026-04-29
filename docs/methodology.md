---
layout: default
title: Methodology — The Whiteboard Pipeline
permalink: /methodology/whiteboard/
---

> Part of the [Methodology Index](/methodology/). This page covers how Fathom turns an indexed paper into a multi-level Excalidraw whiteboard you can zoom into. The companion [Paper methodology](/methodology/paper/) covers the underlying paper-indexing and lens pipeline.

# The Whiteboard pipeline

The Whiteboard is a separate tab next to the PDF view. After a paper indexes, Fathom builds a hand-drawn Excalidraw diagram explaining the paper's **core methodology and algorithms** — not literature, not section structure. You can zoom into any node to see a more detailed sub-diagram. Two zoom levels in v1; Level 3 (algorithm-level napkin cards) is a follow-up.

The full design spec lives at [`.claude/specs/whiteboard-diagrams.md`](https://github.com/anthropics/fathom/blob/main/.claude/specs/whiteboard-diagrams.md) in the source tree. This page is the user-facing *operations* version: what actually happens at each step, what to look for in logs, what to do when it goes wrong.

## The two-pass shape

```
[Indexing complete]                       [User opens Whiteboard tab]
       │                                          │
       │                                          ▼
       │                                  [Inline consent prompt]
       │                                  "Generate whiteboard?
       │                                   ~$3 · ~2 min"
       │                                          │ accept
       ▼                                          ▼
[Pass 1 — UNDERSTAND]                     [Pass 2 — RENDER (Level 1)]
   Opus 4.7 (1M context)                     Opus 4.7 + Whiteboard MCP wrapper
   Reads ENTIRE paper                        Cached: Pass 1 output
   Tools: Grep on content.md                 Tools: read_diagram_guide,
   Output: Markdown                                  create_node_with_fitted_text,
   "understanding doc"                               connect_nodes, describe_scene,
                                                    export_scene, Read
                                            Output: .excalidraw scene JSON
                                                    (authored directly via MCP
                                                     tools — no DSL middle step)
                                                    │
                                                    ▼
                                          [Renderer mounts via api.updateScene]
                                          (figures embedded inline)

                            ──────────────────────────────────

[Level 1 lands → eagerly pre-warm Level 2 expansions in parallel]
                            │
                            ▼
            [Pass 2 — RENDER (Level 2 × N)]
               Opus 4.7 + MCP wrapper · Promise.all
               Cached: Pass 1 output         (each call is independent
               Output: one .excalidraw         and shares the cached prefix —
                       scene per drillable     parallelism is free)
                            │
                            ▼
            [Renderer offsets each L2 by parent.y + parent.h + 200]
            (vertical drill placement; animated zoom in when the user
             clicks a drillable node; frames usually already painted)
```

## Pass 1 — Understand

**What it does.** Loads the entire indexed paper into Opus 4.7's 1M-token context window — `content.md`, figure captions, the digest, the optional purpose anchor — and asks the model to produce a structured-but-loose markdown document describing the paper's goal, core methodology, components, and a suggested diagram structure for Levels 1 and 2.

**Why Opus 4.7, not Sonnet.** Long-context selection is exactly what Opus is built for. The whole paper fits; the model decides what's important. We deliberately avoid a multi-stage extraction pipeline because narrowing too early loses information that later passes might need.

**Why not RAG.** Fathom's foundational principle (CLAUDE.md §6): no embeddings, no semantic search. The paper is already a folder Claude can navigate as a file system. Pass 1 doesn't need RAG because the entire paper fits in context; for the rare case where it doesn't (long surveys), we chunk by section using the digest, run Pass 1 per super-section, and merge.

**Tools.** Pass 1 has read-only `Grep` on `content.md`. Not for retrieval (the paper is already loaded) but for self-verification — when the model is about to commit a quote, it can grep to confirm the wording is verbatim. This is the Chain-of-Verification pattern (Dhuliawala et al. 2023). No `Read`, no `Bash`, no `WebSearch` — Pass 1 is purely about understanding what's in front of it.

**Output.** Markdown with H2 sections (Goal, Core methodology, Components, Suggested Level 1 diagram, Suggested Level 2 expansions). The structure is a *suggestion*, not a contract — the user told us "rigorous structures can often be counterproductive when working with agents." If a paper doesn't fit the standard shape (e.g. a theory paper), the model adapts the headings.

**What to look for in logs.** `[Whiteboard Pass1]` lines. Cost per call (~$1.35 for a 10pp paper), latency (~50s), input token count, output token count. If output is truncated (very long papers), you'll see a `truncated_at` field. If Grep was called, you'll see `[Whiteboard Pass1] grep: <pattern>` lines.

**Failure modes.**

- **Long papers (>80k input tokens)**: v1 ships the single-call path. Most research papers fit comfortably in Opus 4.7's 1M context window; surveys and book chapters may produce a degraded understanding doc as long-context attention degrades past the RULER benchmark's 80k threshold. The chunked-by-section + thin-merge fallback is described in the spec and tracked in todo.md #57; it lands the first time a user reports a degraded understanding doc.
- **Pass 1 returns empty / unparseable**: the renderer surfaces the error state with a "Try again" button. The whiteboard tab persists no scene; the user can retry via consent + Generate.
- **Theory / survey papers**: Opus is asked to detect this in the system prompt and adapt its sections (theorems instead of stages, taxonomy instead of pipeline). The renderer's tolerant DSL accepts whatever shape Sonnet emits — Pass 2 just produces fewer drillable nodes for theorem-shaped papers.

## Pass 2 — Render (called per diagram)

**What it does (post-2026-04-26 MCP architecture).** Pass 2 drives an SDK-instantiated **Whiteboard MCP wrapper** (`src/main/mcp/whiteboard-mcp.ts::createWhiteboardMcpWithStateAccess`) and authors the `.excalidraw` scene directly via tool calls. No DSL middle step, no ELK layout pass, no `convertToExcalidrawElements` skeleton conversion — the agent emits the Excalidraw shape the renderer loads. Single source of truth.

**Why MCP-driven authoring.** The user explicitly wanted *"the agent to have the best tools accessible through the language it understands"* and *"see what they drew."* The wrapper exposes six tools: `read_diagram_guide`, `create_node_with_fitted_text`, `connect_nodes`, `describe_scene`, `export_scene`, `clear_scene`. The agent reads the guide once, creates nodes one at a time, connects edges, calls `describe_scene` as a self-critique step (counts, positions, broken-binding check), then `export_scene`. Caller (`runPass2`) snapshots the state via `getScene()` after the stream finishes — defensive against the agent forgetting `export_scene`.

**Architecture choice (Option C).** We do **not** spawn the upstream `yctimlin/mcp_excalidraw` Express + stdio pair (the upstream is designed for chat clients with a live shared canvas, which Fathom doesn't need). The vendored upstream lives at `.vendor/mcp_excalidraw-reference/` for reference only. Full design captured in `.claude/specs/whiteboard-mcp-pivot.md` and the `fathom-excalidraw` skill.

**Server-side text fitting.** The wrapper's `create_node_with_fitted_text` measures label + summary using a character-width approximation matching the rendered Excalifont/Helvetica font sizes (10 px/char for 16 px Excalifont labels, 7.5 px/char for 13 px Helvetica summaries — over-estimated so the rect always contains its text). Sizes the rect to fit BEFORE creating; emits rect + bound text element with `containerId` properly set. This is the load-bearing fix for "text overflows the boxes" — the agent doesn't compute geometry; the wrapper does.

**Tools.** Pass 2 has the six wrapper MCP tools + `Read` (for citation grounding against `<indexPath>/content.md`). No `Write`, `Bash`, `WebSearch`, or upstream-MCP tools. `maxTurns: 30` leaves headroom for self-correction.

**Model.** Opus 4.7 throughout (Pass 1 + Pass 2). User override 2026-04-25: *"You should have been using Opus 4.7"* — quality consistency matters more than per-call cost.

**Caching.** Pass 2 reuses the Pass 1 understanding doc as the cached prefix (passed to the Claude Agent SDK). The `[Whiteboard Pass2]` log line reports `cache=HIT` or `cache=miss`. Cache HIT cuts input cost by 90% — measured ~$0.40 per L1 + ~$0.30 per L2 in the 2026-04-26 close-the-loop run.

**Eager Level 2 pre-warm.** The renderer kicks off all Level 2 expansions in parallel as soon as Level 1 lands (`Promise.all` — each call is independent and shares the cached prefix). Click feels instant because the L2 frame is usually already painted. Cancellable: if the user closes the tab mid-warm the abort controllers cancel the in-flight calls.

**Visual continuity rules** (encoded in the wrapper's `DIAGRAM_GUIDE` constant):

- ≤ 5 nodes per diagram (Cowan 4±1 working memory cap). Wrapper enforces via `describe_scene`'s overflow flag.
- Same Excalifont, same hand-drawn stroke, same palette across all levels.
- Level 2 diagrams sit BELOW the parent L1 node (renderer offsets every element by `parent.y + parent.h + 200`).
- Drillable nodes carry a `⌖` glyph + dashed inner border; leaf nodes carry solid border + no glyph.
- Citation markers (small amber square in node's top-right) follow the same grammar as PDF lens markers.
- One node per diagram is `kind: "model"` (the novel contribution) — renderer fills with warm beige (#fef4d8).
- Embedded paper figures: `figure_ref: {page, figure}` on a node → renderer embeds `<sidecarDir>/images/page-NNN-fig-K.png` next to the rect. Falls back silently if the file doesn't exist.

**What to look for in logs.** `[Whiteboard Pass2] BEGIN paper=… level=N` per call. The agent's tool calls show as `🔧 read_diagram_guide`, `🔧 create_node_with_fitted_text`, etc. on the `onProgress` stream. `[Whiteboard Pass2] END paper=… level=N elements=N tools=N tokens(…) cache=HIT|miss cost=$… t=…ms`. `[Whiteboard UI] L1 mounted` and `[Whiteboard UI] L2 mounted parent=…` for the renderer-side mount events.

**Smoke testing without Electron.** Run `npx tsx scripts/runpass2-smoke.mts` to drive the MCP-driven Pass 2 against a cached Pass 1 doc — ~$0.40 per L1 iteration, no Electron, no UI. Output `.excalidraw` lands in `/tmp`; inspect with `node scripts/inspect-scene.mjs <path>.excalidraw`. See the `fathom-excalidraw` skill for the full smoke-test playbook.

## Anti-hallucination — soft verifier

Pass 1 is encouraged to inline-cite quotes with `[p.N]` page tags. After Pass 1 completes, a **background verifier** greps each cited quote against `content.md`:

- Whitespace + case + punctuation normalised first.
- Accept ≥85% trigram overlap as "verified."
- Hard "unverified" only when overlap is <50% with anything in `content.md`.

Verifier results are logged to `whiteboard-issues.json` in the paper's sidecar folder. The diagram is **never mutated** based on verifier output. Instead, the citation marker carries a two-channel verified/unverified signal:

- **Verified citation**: solid amber square, no glyph.
- **Unverified citation**: dashed amber square outline + faint `?` glyph.

Two channels (shape + glyph), so color-blind / low-vision users still get the cue without relying on color contrast.

If >40% of quotes fail to verify on a paper, a one-time banner appears: *"Some citations may not match the paper exactly — review carefully."* (Threshold is data-driven; we'll calibrate after observing real papers.)

**Why soft, not hard.** v1's design auto-dropped any unverified node; the user (correctly) flagged this as the kind of "rigorous structure" that hides the model's actual reasoning. Better to surface unverified citations as such and let the user judge than to silently delete content.

## The side chat (deferred from v1)

The right-rail side chat — patch loop with typed ops (`add_node`, `relabel`, `split_node`, `merge_nodes`, `add_edge`, `change_kind`) and a regenerate-mode escape hatch — is **not in the v1 build**. The spec describes it; the implementer was asked to focus on the diagram pipeline + rendering + drill-in first and to revisit the side chat after the core works.

When it lands, the design is unchanged from the spec: 320 px collapsible right rail, scoped per-frame (Level 1 vs. Level 2 of Encoder are separate threads), patch-mode by default with a regenerate-mode escape when the model wants to touch >40% of nodes.

For now, regenerating means: the user clicks "Try again" on a failed run, which calls `whiteboard:generate` again and replaces the saved understanding doc + scene.

## Persistence

Whiteboard state lives at `~/Library/Application Support/Fathom/sidecars/<contentHash>/whiteboard.excalidraw` (alongside the rest of the paper's index). Each zoom level is an Excalidraw `frame` element; all frames live in the single `.excalidraw` file. Per-node metadata (citation, parent, drillable, generated-at) lives in Excalidraw's `customData` field, which round-trips through the file format for free. Side-chat history lives at `whiteboard-chat.json` keyed by frame ID.

Move the PDF and the whole sidecar folder travels with it. Re-opening the paper restores the whiteboard exactly as the user left it.

## Cost & latency

For a typical 10-page paper:

| Stage | Cost (first run) | Latency |
|---|---|---|
| Pass 1 (Opus 4.7) | ~$1.35 | ~50 s |
| Pass 2 — Level 1 (Opus 4.7, MCP-driven, cache HIT) | ~$0.40 | ~80 s |
| Pass 2 — Level 2 ×5 (Opus 4.7, MCP, cache HIT, parallel) | ~$1.40 (5 × ~$0.28) | ~80 s wall-clock (parallel) |
| **Total first-time generation** | **~$3.15** | **~130 s to L1 paint, ~140 s to L1+L2 fully expanded** |
| Per side-chat patch | ~$0.05 | ~3 s |

Verified via `npx tsx scripts/runpass2-smoke.mts` runs on 2026-04-26 against the bundled sample paper (ReconViaGen). Cache HIT confirmed on every Pass 2 call against the same paper.

The user's Claude CLI auth pays for this — so consent is required per paper. First Whiteboard-tab click for a paper shows an inline button: *"Generate whiteboard for this paper? · ~$1.90 · ~70 s"*. After accept, the pipeline runs. A Preferences toggle "auto-generate on index" can flip default behavior.

## Tab-level status dot (forcing function)

The Whiteboard tab in the header tab strip carries a small colored dot next to the label so the user can tell "is the AI working on this?" at a glance — without having to switch into the tab. Color + animation grammar matches the inline-ask streaming markers (`fathom-marker-streaming` in `index.css`):

| State | Dot | Notes |
|---|---|---|
| No whiteboard yet (consent pending) | none | The consent affordance lives inside the tab; no dot needed. |
| Pass 1 in flight (~50 s) | red (#d4413a) + 1.2 s opacity pulse | Same red as the streaming marker on the PDF — one unified "working" signal. |
| Pass 2 / Level 1 hydrate in flight | red, still pulsing | Continuous with Pass 1 — the user sees one streaming state. |
| Pre-warming Level 2 expansions in parallel | red, still pulsing | The dot stays red until every in-flight expansion completes. |
| Ready (Level 1 painted, no in-flight expansions) | amber (`var(--color-lens)`), no animation | Same amber as PDF lens markers and citation markers inside diagrams. |
| Failed | red, no animation | Combined with the failure UI inside the tab. |

This is a forcing function for "is it ready" awareness — the user does not have to remember to check the tab. Color + motion are two channels (cog reviewer §6 colour-blindness rule) so the screen-reader `aria-label` ("Whiteboard generating", "Whiteboard ready", "Whiteboard generation failed") provides the third independent channel.

## Drill UX

Two equivalent ways to drill from a Level 1 node into its Level 2 expansion (per CLAUDE.md §2.1: every interaction needs a keyboard path AND a gesture path):

1. **Click the drillable Level 1 node** (preferred — discoverable, no learning curve). Drillable nodes carry a dashed inner border + amber ⌖ glyph at the bottom-right. Click → Level 2 frame becomes the active focus, breadcrumb updates to "Paper ▸ <node label>", canvas animates `scrollToContent` over 320 ms with a `cubic-bezier(0.4, 0, 0.2, 1)` curve (inside Doherty's 400 ms threshold).
2. **⌘+pinch on the node** (matches the existing PDF dive gesture — same recursion grammar, CLAUDE.md §2.1). Same animation curve, same destination. Useful when the user already has the trackpad in pinch-mode from the previous interaction.

**Drill direction is VERTICAL.** The Level 2 frame sits BELOW its Level 1 parent in the Excalidraw scene, not to the right. The user's mental model is "zooming into a node moves you DOWN the page, not across" (PM update 2026-04-25). Same recursion grammar applies if Level 3 ever ships. The animated `scrollToContent` handles smooth panning; the positional choice is a layout decision in `WhiteboardTab.tsx::mountLevel2Frame`.

Because Level 2 expansions are pre-warmed in parallel as soon as Level 1 lands (see "Eager Level 2 pre-warm" above), the typical drill is *instant* — the L2 frame is already painted, the click just animates the camera to it.

To drill back out: click the breadcrumb's "Paper" segment, or two-finger swipe right (matches existing lens history navigation).

## Self-critique loop (now intra-Pass-2, was a separate Pass 2.5)

Pre-2026-04-26 the architecture had a separate Pass 2.5 critique stage that rasterised the WBDiagram to a PNG and asked Opus to review it. **That stage is gone.** The MCP-driven Pass 2 self-critiques inside the same tool-use loop via `describe_scene`:

- The wrapper's `describe_scene` returns a structured text dump (counts by element kind, per-node positions, broken-binding check, ≤5-nodes flag).
- The system prompt instructs the agent to call `describe_scene` BEFORE `export_scene` as the explicit verification step.
- If `describe_scene` reports problems, the agent fixes via more tool calls (or `clear_scene` + retry).
- No separate Opus call, no PNG round-trip, no patch-vs-replace ops list.

This is the "AI agents that produce visual artefacts must see-and-iterate" principle (CLAUDE.md §0), implemented at the right level: the agent sees state during authoring, not after rendering.

Cost vs. old Pass 2.5: net ~$0.15 saved per paper (no separate critique calls), and ~30s of latency removed (no PNG export + Read round-trip).

## Pass 2.5 — visual self-critique (re-introduced 2026-04-27, after intra-Pass-2 alone proved insufficient)

The intra-Pass-2 `describe_scene` self-critique is necessary but not sufficient. Round-9 user critique surfaced three structural defects (zone-vs-zone overlap, text-vs-container overflow, arrow-path-vs-text crossing) that `describe_scene`'s element-bbox math read as clean while the *rendered pixels* were visibly broken. The agent that authored the scene cannot trust the scene without seeing the render — same close-the-loop principle (CLAUDE.md §0) that applies to human implementers, applied in-product.

**Pass 2.5 is a separate vision call that runs after Pass 2 emits a WBDiagram and the renderer rasterises it to PNG.** It does NOT replace `describe_scene` — both run; `describe_scene` catches scene-graph bugs cheaply during authoring, Pass 2.5 catches pixel-level layout bugs the scene-graph cannot.

### Where it sits in the pipeline

```
Pass 2 (Opus 4.7 + MCP) → emits .excalidraw scene
                  │
                  ▼
Renderer rasterises → exportToCanvas → PNG (in renderer process)
                  │
                  ▼
whiteboard:writeRenderPng IPC → main writes <sidecar>/wb-iter-<n>.png
                  │
                  ▼
whiteboard:critique IPC → runCritique (src/main/ai/whiteboard-critique.ts)
                  │   • Loads PNG bytes from disk
                  │   • Spawns SDK MCP server exposing look_at_render tool
                  │   • Calls Opus 4.7 (vision) with the rubric system prompt
                  │   • Agent calls look_at_render → sees PNG inline
                  │   • Agent emits structured-JSON verdict
                  ▼
verdict { pass: bool, defects: [{ kind, stage_attribution, location, fix_suggestion, severity }] }
                  │
                  ▼
Renderer's runCritiqueLoop decides:
  • verdict.pass === true (or unparseable) → ship to live scene
  • verdict.pass === false + verdict.fix === 'patch' → applyOpsToDiagram + re-loop
  • verdict.fix === 'replace' → swap diagram + re-loop
  • iter >= 3 → ship best-we-have (never block the user)
```

### What the critique prompt evaluates

The system prompt in `src/main/ai/whiteboard-critique.ts` embeds the rubric in-line (the file `.claude/critics/whiteboard.md` is in the source tree, not the shipped Electron app, so embedding is mandatory). Two checklist tiers:

**Tier 1 — Geometric checklist (mandatory, pixel-level):**
1. Zone-vs-zone overlap (zones obscuring each other's content).
2. Text-vs-container overflow (text past a node/callout/zone-label edge).
3. Arrow-path-vs-text crossing (the path, not just the label, crossing a text element).
4. Element-vs-element overlap (nodes/callouts overlapping in rendered pixels — bbox math can read clean while padding/stroke makes pixels collide).

Any geometric defect is `severity: "fail"` regardless of how good the content is — unreadable diagrams are higher-priority failures than content-quality nuances.

**Tier 2 — Rubric axes (semantic):**
- Zones present and meaningful.
- Color roles correct (blue=input, green=output, amber=notes, red=error, purple=processing).
- Modality matches content (sequential → flow, math → big-text-with-box-no-shapes, etc.).
- Component-as-answer framing (every node visibly answers a question that traces back to the paper's ground problem).
- Section numbering sequential.
- Equations decomposed (name + intent + per-symbol explanation).
- Container fit (no oversized empty boxes).

### Stage attribution — the load-bearing addition

Every defect carries `stage_attribution` naming which pipeline stage produced it:

| `stage_attribution` | What this means | Re-run cost |
|---|---|---|
| `pass1_narrative` | The understanding doc didn't surface a fact or question the diagram needed (ground problem missing, component questions missing, term wrong) | ~$1.35 (full Pass 1) |
| `pass_a_planning` | The layout intent was wrong (no zones, sections out of order, modality mismatched, component framing not as question-as-answer) | ~$0.40 (Pass 2 with cached prefix) |
| `pass_b_placement` | Elements placed in wrong positions (overlapping, wrong colors picked from the palette, narrative ordering broken, arrow endpoints poorly chosen) | ~$0.40 (Pass 2 with cached prefix) |
| `wrapper_geometry` | MCP tool wrapper failed to enforce size / collision (text overflows, callout body too big for callout, zone/zone overlap not rejected) | ~$0 (code fix in `src/main/mcp/whiteboard-mcp.ts`) |
| `renderer_layout` | Bug in render-side ELK / `convertToExcalidrawElements` / `exportToCanvas` (image embed didn't resolve, stroke width off) | ~$0 (code fix in `src/renderer/whiteboard/`) |

The critique prompt instructs the agent: when in doubt between adjacent stages, attribute to the EARLIEST stage that could have prevented the defect — the isolation principle wants the fix as far upstream as possible.

The per-stage CLI tooling (todo #64 Track C, owned by `isolation-impl`) keys off `stage_attribution`: when verdict says `wrapper_geometry`, the loop runs only the wrapper-geometry CLI to re-emit the affected nodes with no upstream re-execution.

### Cost & latency budget

Each Pass 2.5 round costs roughly $0.005–$0.015 at Opus 4.7 vision pricing (input is one ~700KB PNG ≈ ~1.5K tokens + a few hundred tokens of scene JSON; output is the JSON verdict, ≤ 500 tokens). Latency ~5–8 seconds per round. The renderer's `runCritiqueLoop` caps at 3 iterations (`CRITIQUE_MAX_ITERATIONS` in `WhiteboardTab.tsx`), so worst-case Pass 2.5 spend per paper is ~$0.045 + ~24 s wall-clock. After 3 iterations, the loop ships the latest diagram regardless — the user never sees a permanent stall on a critique disagreement.

### Verdict shape — strict JSON

The IPC returns `{ verdict: CritiqueVerdict | null, costUsd: number }` to the renderer. The verdict shape:

```typescript
{
  pass: boolean,
  defects: Array<{
    kind: string,                                     // short snake_case tag
    stage_attribution: 'pass1_narrative' | 'pass_a_planning' |
                       'pass_b_placement' | 'wrapper_geometry' |
                       'renderer_layout',
    location: { x: number, y: number, width: number, height: number },
    fix_suggestion: string,                           // tool-layer fix preferred
    severity: 'fail' | 'warn'
  }>
}
```

`pass` is `true` only if every defect is `severity: "warn"` (or the array is empty). `verdict: null` from the IPC means the agent's reply failed to parse — `runCritiqueLoop` treats that as "approved" so a single parse bug never blocks the user from seeing their diagram.

### What to look for in logs

- `[Whiteboard Pass2.5] writeRenderPng paper=… iter=N bytes=… → <sidecar>/wb-iter-N.png` — the renderer-side PNG persisted.
- `[Whiteboard Pass2.5] BEGIN paper=… iter=N png=… scene=…ch` — the vision call started.
- `[Whiteboard Pass2.5] END paper=… iter=N body=…ch tools=… tokens(in=…, out=…) cost=$… t=…ms verdict=pass=true|false defects=N | unparseable` — the result.
- `[Whiteboard UI] Pass2.5 iter=N verdict=… cost=$…` — renderer-side; the loop's per-round trace.

### Where to look when the critique seems wrong

1. **The critique APPROVED a render with a visible defect.** Check the geometric-checklist tier: did the agent miss the four mandatory checks? If so, the system prompt's checklist needs sharper language. The critic-rubric file `.claude/critics/whiteboard.md` is the long-form home; embed concise versions of any updated rule into the system prompt in `src/main/ai/whiteboard-critique.ts`.
2. **The critique REJECTED a render that looked fine.** Check the agent's `fix_suggestion` and `kind` — often a false-positive is the agent flagging acceptable whitespace as overflow. Tighten the rubric's "container fit" thresholds (currently >50% whitespace = warn).
3. **The verdict is `null` (unparseable).** The agent didn't return clean JSON. Check if `body` (logged at END) starts with prose or a markdown fence — `parseVerdict` strips a single ```json fence but not embedded prose. The system prompt's "NO PROSE BEFORE OR AFTER" instruction may need re-emphasis.
4. **The critique ran but the loop never re-ran the broken stage.** That's the renderer-side `runCritiqueLoop`'s job (and isolation-impl's per-stage CLIs). Pass 2.5 emits the verdict; downstream consumption is on the loop driver. The current loop only handles `verdict.fix === 'patch' | 'replace'`; it does NOT yet route on `stage_attribution` — that wiring lands when the per-stage CLIs ship.

## Per-stage isolation — re-run the broken stage, not the whole pipeline

Per CLAUDE.md §0 ("Isolation and investigation") and §8 ("The in-product agent must close its own visual loop with per-stage isolation"). When Pass 2.5 attributes a defect to one stage, the team — and eventually the in-product agent — re-runs ONLY that stage, NOT the whole $1.90/paper Pass 1+2 chain. Each stage has a dedicated CLI under `scripts/` that consumes the prior stage's saved output and produces just its own output.

### The five stages

| Stage | What it does | CLI | Input format | Output format | Runtime | API spend |
|---|---|---|---|---|---|---|
| 1 | Pass 1 narrative — Opus reads the indexed paper, writes the understanding doc | `scripts/wb-stage1-pass1.mts` | sidecar dir (must contain `content.md`) | `whiteboard-understanding.md` | ~50 s | ~$1.35 |
| 2 | Pass A planning — Opus produces a JSON plan (sections, zones, elements, edges, ground-problem sentence, per-node questions) with NO MCP tool calls | `scripts/wb-stage2-passA.mts` | `whiteboard-understanding.md` | `whiteboard-plan.json` | ~30 s | ~$0.20 |
| 3 | Pass B placement — Opus drives the same MCP wrapper prod uses, executing the plan as tool calls | `scripts/wb-stage3-passB.mts` | `whiteboard-plan.json` (+ optional understanding for citation Read) | `<scene>.excalidraw` | ~80 s | ~$0.40 (cache HIT) |
| 4 | Wrapper geometry — re-validate a saved scene against AC predicates + structural geometric audit (zone/zone overlap, text/container overflow, arrow/text crossing, content overlap) | `scripts/wb-stage4-wrapper.mts` | `<scene>.excalidraw` (+ optional understanding for AC hints) | stdout defect report; exit 0 = pass, 1 = fail | ~1 s | $0 |
| 5 | Renderer / ELK layout — convert scene JSON to PNG via the live Excalidraw mount | `scripts/render-real.mjs` (existing) | `<scene>.excalidraw` | `<out>.canvas.png` + `<out>.page.png` | ~3 s | $0 |

### Worked example — Pass 2.5 attributes a defect to Stage 4

Critic verdict says: `defects: [{ kind: "text_overflow", stage_attribution: "wrapper_geometry", ... }]`. The team's response is NOT to regenerate the whole diagram. Instead:

```bash
# Step 1: confirm the defect from the saved scene with no API spend.
npx tsx scripts/wb-stage4-wrapper.mts \
  --scene /tmp/wb-pass2-smoke-1777264745822.excalidraw \
  --understanding "$HOME/Library/Application Support/fathom/sidecars/<HASH>/whiteboard-understanding.md"

# Stage 4 prints the per-element defect list; verifies the critic's attribution.
# If the report has zero FAILs but the user reported a visible defect, the
# attribution was wrong — re-route to Stage 5 (renderer bug) instead.

# Step 2: fix the wrapper rejection logic in src/main/mcp/whiteboard-mcp.ts.
# Add the missing accept/reject check (compute-then-reject per CLAUDE.md §8).

# Step 3: re-run Stage 3 only — same plan, same understanding, $0.40 not $1.90.
npx tsx scripts/wb-stage3-passB.mts \
  --plan "$HOME/.../whiteboard-plan.json" \
  --understanding "$HOME/.../whiteboard-understanding.md" \
  --out /tmp/wb-stage3-fixed.excalidraw

# Step 4: re-validate.
npx tsx scripts/wb-stage4-wrapper.mts --scene /tmp/wb-stage3-fixed.excalidraw

# Step 5: render to confirm the visible fix.
node scripts/render-real.mjs /tmp/wb-stage3-fixed.excalidraw /tmp/wb-stage3-fixed
```

Total cost of this fix loop: ~$0.40 (one Stage 3 re-run). Compare to the naive "regenerate the whiteboard" path: $1.35 (Stage 1) + $0.20 (Stage 2) + $0.40 (Stage 3) = $1.95. Per-stage isolation saves the prior $1.55 of cached Stage 1 + Stage 2 work.

### How the in-product Pass 2.5 hook consumes these CLIs

The in-product Pass 2.5 verdict (`whiteboard:critique` IPC) returns each defect with a `stage_attribution`. The renderer-side `runCritiqueLoop` (in `WhiteboardTab.tsx`) is the consumer:

- `stage_attribution: "pass1_narrative"` → re-run Stage 1 (rare; usually means the paper indexing missed content). Triggered via the `whiteboard:generate` IPC's regenerate path, NOT a separate stage hook in the renderer.
- `stage_attribution: "pass_a_planning"` → re-run Stage 2 with a focused fix prompt (e.g. "the prior plan missed sub-question N for node X — re-plan with that included"). The Stage 2 CLI is the substrate; the IPC path lands when the renderer's Pass 2.5 loop is wired to route by attribution.
- `stage_attribution: "pass_b_placement"` → re-run Stage 3 with the SAME plan and a focused critique-feedback addition. Most defects land here.
- `stage_attribution: "wrapper_geometry"` → NO Claude re-run. Code fix in `src/main/mcp/whiteboard-mcp.ts` (the wrapper itself), then re-run Stage 3 once to re-emit the affected nodes through the corrected wrapper.
- `stage_attribution: "renderer_layout"` → NO Claude re-run. Code fix in `src/renderer/whiteboard/` (or `scripts/render-real-entry.jsx` if the bug is in the harness), then re-run Stage 5.

The Stage 2 / Stage 3 / Stage 4 CLIs share the same input/output format that the in-product pipeline uses (single source of truth for prompts via `src/main/ai/whiteboard-pass2-system.ts`, single source of truth for the MCP wrapper via `src/main/mcp/whiteboard-mcp.ts`), so when the renderer's loop is wired to route by attribution, it can call the same code paths the CLIs do.

### When to use the CLIs vs the in-product loop

- **In-product loop (Pass 2.5 inside the running app):** the user is reading a paper; the loop self-heals up to 3 times before showing the diagram. Bounded cost per paper, bounded latency.
- **CLI loop (this section):** the team is debugging a defect class — the user reports something the in-product loop missed (or shipped with), and the team needs fast iteration without rebuilding the Electron app. CLI iteration is ~30 s per round, $0.40 for Stage 3, $0 for Stages 4–5.

The CLIs were built first because they are lighter to iterate on; the in-product Pass 2.5 hook (the consumer) is built in parallel by `pass25-impl`. Both share the same stage definitions, the same prompts, the same wrapper.

## Doherty acknowledgement contract

Every user-initiated whiteboard interaction must produce a visual response within one frame (≤ 400 ms, target ≤ 50 ms). Specifically:

- **First click on the Whiteboard tab**: skeleton + 5 placeholder node outlines + "Generating…" glyph appear in 1 frame. Real nodes hydrate as Pass 2 streams in.
- **Click on a drillable node (Level 2 drill-in)**: parent-frame outline begins drawing AND spinning `⌖` glyph appears within 50 ms. Even if Level 2 generation hasn't started yet (cold cache), the user sees acknowledgement.
- **Side-chat patch submission**: affected nodes get a soft outline pulse within 50 ms.

The 70 s first-paint and ~5 s per-iteration latencies are fine *as long as the immediate ack is in*. Implementation must not let any user-visible interaction wait for a network call before painting confirmation.

## Where to look when something is wrong

1. **The diagram looks wrong / missing components.** Read `content.md` (the indexed paper) — what's there determines what Pass 1 can see. If Pass 1 missed something obvious, check the `[Whiteboard Pass1]` log for truncation or chunking failures. The Pass 1 understanding doc is saved alongside the diagram for inspection.
2. **Citations show `?` markers.** Open `whiteboard-issues.json` in the paper's sidecar — it lists every flagged quote with the closest match it found in `content.md`. Often the issue is paraphrase vs. verbatim, not fabrication.
3. **Click on a node does nothing.** Check the Excalidraw `customData` for that node — if `drillable: false`, it's a leaf by design. If `drillable: true` and nothing happens, the Pass 2 call for that node may be in `pending` / `failed`; check the side-chat error state.
4. **Level 2 looks unrelated to Level 1.** This is a Pass 2 grounding bug — the cached Pass 1 didn't carry enough structure for the L2 prompt to anchor. File an issue with the paper hash + the diagram screenshot; the Pass 1 understanding doc will be in the sidecar for diagnosis.

## Known limits and follow-ups

- **No Level 3 in v1.** Algorithm-level napkin cards are deferred to a follow-up. Level 1 + Level 2 only.
- **No side chat in v1.** Iterative patch-loop refinement is deferred (see §"The side chat" above). Today, "regenerate" means the user clicks "Try again" on a failed run; per-node patches are not yet wired.
- **No "Lite" cost-tier toggle in v1.** A `whiteboardSonnetLite` setting is reserved in the schema for the cog-reviewer non-blocking note's $0.50 Sonnet-only Pass 1 alternative. We surface it after observing real acceptance rates on the default Opus-priced version, per the spec's "instrument first, build later" direction.
- **One whiteboard per paper.** No comparing two papers' diagrams side-by-side yet.
- **Public papers only.** No support for protected PDFs or papers behind paywalls (orthogonal to this pipeline).
- **English papers tested.** Other languages should work because Opus is multilingual, but we've observed Pass 1 selecting components correctly only in English so far.
- **Cost may surprise users.** ~$1.90/paper is significantly more than the lens (~$0.05/dive). Consent prompt explicit about this.
- **5-node ceiling enforced at parse time.** If Sonnet emits >5 nodes for a single diagram, the parser keeps the first 5 and drops dangling edges. Cog reviewer §1 hard rule (Cowan 4±1 working memory cap) — silently violating it would defeat the diagram's purpose.

## Updating this page

When the implementer changes the pipeline, this page must change in the same commit. The CLAUDE.md "AI-built-product principle" treats methodology + logs + code as one shipping unit, not three separate concerns. If the doc and the code drift, file the gap as a bug — both need to land in the same change.
