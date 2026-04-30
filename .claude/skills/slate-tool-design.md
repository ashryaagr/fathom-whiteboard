---
name: slate-tool-design
type: skill
audience: any agent extending or reviewing the layers Slate controls between the agent and the canvas
established: 2026-04-27
---

# Tool design — wrappers enforce constraints; prompts only guide intent

This is a CORE engineering principle in Slate (CLAUDE.md §8). Read it
before adding to or reviewing any layer between the agent and the
canvas — the SKILL prompt, the SYSTEM_SUFFIX, `resolveSceneFromInput`,
or the `<Whiteboard>` render path.

## The principle in one line

> When the agent's call would produce an invalid artifact, a layer
> *we control* should reject the call (or transform it) with a
> precise behaviour stating which constraint failed and what would
> satisfy it — NOT the prompt should warn the agent in advance.

## Why

Prompt-level rules ("text must fit," "labels must not overlap,"
"callouts size to content") are *guidelines* the agent may forget,
under-budget, or override. The user's verbatim critique on this
class of problem (transferred from Fathom but applies to Slate
verbatim):

> *"We should have structural ways to prevent this, or tools can
> just simply do the computation and let the tool know when it's
> going to get out of the box or when something's going to overlap,
> so that these kinds of problems don't happen. We need to
> fundamentally think, rather than just improving the prompt, on
> how we can make better tools and … better agent harnesses."*

A constraint enforced in a layer we control:
- runs every call (no forgetting)
- gives the agent a *concrete* behaviour, not a guideline
- becomes a forcing function — the bad output is literally
  impossible to ship through that layer
- composes with other constraints automatically (every layer
  enforces its own slice; the union is the system invariant)

A constraint enforced only in a prompt:
- depends on the agent reading and remembering the rule
- fires *after* the bad output has been emitted (best case it
  shows up in the rendered canvas; worst case it ships)
- is silently weakened by every new prompt rule that competes for
  attention
- requires another iteration round when the agent ignores it

## Slate's available layers (in upstream-to-downstream order)

Slate runs on the upstream `excalidraw-mcp` MCP — we do NOT
maintain our own MCP wrapper, by design. So the levers we control
are different from Fathom's (Fathom has `whiteboard-mcp.ts`; Slate
does not). The Slate layers, from most-upstream to most-
downstream, are:

1. **`src/SKILL.md`** — the durable design playbook the agent
   reads on every run. The right home for design rules that don't
   change paper-to-paper: "callouts size to content with consistent
   padding," "math goes in big text + colored box, not shapes,"
   "use the subject's vocabulary."
2. **`SYSTEM_SUFFIX` in `src/pipeline.ts`** — Slate-specific layer
   on top of the SKILL. The right home for "ground-problem
   framing," "component-as-answer questions," any Slate-specific
   UX constraint that doesn't belong in a general-purpose
   diagram-skill.
3. **`buildUserMessage` in `src/pipeline.ts`** — message-shaping
   for the specific run. Title prefix, focus block, paper content
   placement.
4. **`resolveSceneFromInput` in `src/pipeline.ts`** — the closest
   thing Slate has to a wrapper. Filters out pseudo-elements
   (`cameraUpdate`, `restoreCheckpoint`, `delete`) before they hit
   the renderer; applies `restoreCheckpoint` deltas locally so the
   renderer sees a fully-resolved scene. New geometric checks
   (e.g. element-id collisions, broken bindings, malformed types)
   could land here.
5. **`Whiteboard.tsx` render path** — last line of defense for
   visual defects that survive the agent. Render-side overflow
   visualisation, focus-state highlights, responsive container
   sizing.

## When to apply

Trigger this principle whenever a defect in the canvas is found
that has a geometric or structural definition:
- coordinates (x, y) where the result must sit inside a parent bbox
- dimensions (width, height) that must accommodate text or other content
- text strings whose rendered size depends on font/wrap/line-height
- IDs that must reference existing scene elements with valid relationships
- pseudo-elements that the agent emits but the renderer can't handle

For each such case, the question is: which of the five layers
above is the highest-leverage fix?

- **Per-paper / per-run quirk** → SYSTEM_SUFFIX, but only if the
  rule wouldn't generalise (rare).
- **Generalisable design rule for diagrams** → SKILL (the durable
  upstream).
- **Validate-then-reject on element shape** → `resolveSceneFromInput`.
- **Visual defect the user can SEE and act on** → render path.

The hierarchy puts the SKILL highest because Slate's
philosophical commitment is that the SKILL playbook is doing the
heavy lifting; the pipeline's job is to deliver it intact.
Bloating SYSTEM_SUFFIX with paper-specific guidance gradually
defeats that. SYSTEM_SUFFIX should remain short.

## Worked examples

### Example 1 — pseudo-element filtering

The vendor MCP defines three "pseudo-elements" that are part of
its wire protocol but NOT real Excalidraw element types:
`cameraUpdate`, `restoreCheckpoint`, `delete`. Excalidraw's
`updateScene` rejects/ignores scenes containing them.

**Wrong layer**: telling the agent in the SYSTEM_SUFFIX "don't
emit cameraUpdate." The agent might forget; the vendor MCP's
documentation says cameraUpdate is *required* as the first
element of every `create_view`.

**Right layer**: `resolveSceneFromInput` already filters out
pseudo-elements before they hit the renderer. The agent emits
the canonical wire-protocol form (including cameraUpdate); we
strip it before the canvas sees it. Both halves of the pipeline
do their canonical work.

This is the reference example of the principle in Slate: the
defect class doesn't reach the renderer because a layer *we
control* handles it. The agent doesn't need to know.

### Example 2 — text overflow

If a render shows "the body of the KEY IDEA callout overflows
its box," ask: where can this be prevented?

- **SKILL** (highest leverage). The SKILL playbook should already
  contain a rule about callout sizing. If the rule is missing or
  weak, *strengthen the SKILL*. A worked counter-example
  ("here's a callout the agent sized correctly; here's the
  reasoning") is more durable than a prompt rule.
- **SYSTEM_SUFFIX**. As a fallback, the suffix can re-emphasise
  the rule for Slate-specific runs. But SYSTEM_SUFFIX is short on
  purpose; don't accrete every defect class here.
- **`resolveSceneFromInput`**. We could add a wrap-aware check
  that fails the call if the body wraps to N lines but the
  callout's height is < N × lineH. This is a heavier intervention
  — it requires us to estimate Excalifont metrics, which the
  vendor's renderer ultimately decides. Risk: false positives.
  Use sparingly.
- **`Whiteboard.tsx`**. A render-side overflow indicator (red
  outline if a text element extends past its container) makes
  the defect visible to the user even when it slips through.
  Doesn't fix the defect, but makes it diagnosable.

The rule: **start at the SKILL; descend the layers only if the
SKILL fix can't carry the constraint.** Each descent is more
specific to Slate, so each one is a tax on the "deliver the SKILL
intact" commitment.

## Anti-patterns

### Anti-pattern 1 — adding to SYSTEM_SUFFIX what belongs in the SKILL

The SYSTEM_SUFFIX is short on purpose. Every paragraph added
competes for the agent's attention with the SKILL above it. If
the rule is general (applies to every diagram, regardless of
subject), it belongs in the SKILL — propose the change to the
SKILL upstream, or carry a Slate-side patched copy in
`src/SKILL.md` with a comment naming the upstream rule it
extends.

### Anti-pattern 2 — silent filtering without a log line

`resolveSceneFromInput` filters pseudo-elements but doesn't
currently log when it does so. That's fine for routine wire-
protocol filtering. But if we add geometric filtering ("rejected
this element because its label collides with element X"), the
agent must see *why* on the next turn — log via `cb.onLog` so
the agent's next conversation turn includes "the prior call had
N elements rejected for reason X" and the agent learns.

### Anti-pattern 3 — rejection without a fix path

A render-side reject that says "text overflows" with no further
info teaches the user nothing. Every rejection visualisation
should include:
1. **What constraint failed** (with measurements).
2. **What was supplied** (the agent's inputs, restated).
3. **What would satisfy** (a concrete suggested fix the agent or
   the user could apply).

### Anti-pattern 4 — wrapper enforces constraint A but skips constraint B

When designing a constraint check, enumerate the *failure modes
the user has flagged* and check each of them. Don't pick the easy
one and call it done. The user critique is the source of truth
for which classes need coverage.

### Anti-pattern 5 — patching the upstream MCP

We do NOT patch the upstream `excalidraw-mcp`. If a defect class
genuinely requires server-side validation, surface it as a PR to
the upstream project, OR transform the input client-side in
`resolveSceneFromInput`. Forking the MCP creates a maintenance
burden Slate's "stay out of the agent's way" principle was
designed to avoid.

## Composability with content-quality rules

Tool-layer enforcement and content-quality rules are NOT
competitors. The right division of labor:

- **Layers we control** enforce single-call structural constraints
  — "this one tool call must produce a valid artifact given the
  current scene state."
- **SKILL / SYSTEM_SUFFIX** enforce content-quality invariants —
  "the diagram as a whole must explain the subject," including
  ones that span multiple tool calls (modality match, narrative
  ordering, ground-problem framing).

If a content-quality rule fires on a class of defect that a
layer *could* prevent geometrically, that's a refactor
opportunity: move the check into the layer. The content-quality
rule stays as belt-and-suspenders for future regressions.

Over time, layer-enforcement grows and content-quality rules
shrink — the system converges toward "the SKILL describes
*what* to draw; the layers ensure that *whatever* the agent
emits is structurally well-formed."

## Summary — the rule

When you're about to add a paragraph to SYSTEM_SUFFIX telling the
agent to avoid some structural defect: **stop**. Ask whether the
defect could be detected at one of the layers above (SKILL,
SYSTEM_SUFFIX, `resolveSceneFromInput`, render). If yes, fix
there. The prompt addition is the wrong layer for structural
enforcement. The right layer is the highest-leverage one in the
stack.
