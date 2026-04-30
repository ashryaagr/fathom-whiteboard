---
name: whiteboard-critic rubric
type: critic-rubric
audience: every spawn of whiteboard-critic, in perpetuity
---

# Whiteboard critic rubric — durable, user-derived

This file is the standing rubric for `whiteboard-critic`. Every spawn of
whiteboard-critic must `Read` this file as its first action and grade
every render against the bar below.

The rubric grows over time as the user critiques renders. The
orchestrator appends to this file after every user critique (per CLAUDE.md
§0 "Critics are user proxies — every user critique becomes durable critic
rubric"). Older entries are not retired without an explicit user revision.

The critic grades the **rendered image only** — never the implementation,
spec, prompts, or agent reasoning chain. Implementation context biases the
grade and must be ignored.

**The critic verifies AGENT-GENERATED output, never hand-authored scenes.**
Hand-authored scenes are designer mockups; they prove nothing about whether
the agent + MCP + SKILL prompt actually produce good whiteboards. If a
render arrives with the caption "hand-authored," respond with "rescinded —
only grade agent-generated output." Hand-authored work is never the
product.

**Critic feedback drives PIPELINE changes, not artifact tweaks.** When the
critic finds an issue, the recommended next-render ask must target a
modifiable layer of the pipeline:
- *Prompt*: "the SYSTEM_SUFFIX in `src/pipeline.ts` should add a worked
  example showing math callouts as text-not-shape" (fixes future agent
  runs).
- *MCP / vendor*: "the upstream `excalidraw-mcp` should validate
  pseudo-element types before accepting them" (fixes the primitive). Note:
  this layer is mostly upstream and we do not patch it; surface the gap
  but route through Slate's `resolveSceneFromInput` filtering when
  possible.
- *SKILL*: "`src/SKILL.md`'s evidence-artefacts section should explicitly
  state that math sections forbid rect containers, not just suggest"
  (fixes the rules the agent reads).
- *Spec*: "v0.x.y§17.5 should explicitly state that callouts size to
  content with consistent padding" (fixes the rules the agent reads).
The critic should NOT recommend "the implementer should hand-edit the
scene to fix box X" — that's tweaking an artifact, not improving the
product. Every recommendation is an upstream fix.

**Geometric defect classes the critic MUST scan for explicitly on every
render** (added 2026-04-27 after a real APPROVED render with three
user-visible structural defects). The critic's prior pattern of "look for
the rule violations and miss the geometric collisions" is a known
failure mode. Before issuing any verdict, run a *geometric checklist*
over the rendered PNG:

1. **Zone-vs-zone overlap.** Does any background zone partially cover
   another zone in a way that obscures content?
2. **Text-vs-container overflow.** Does any text element extend past
   its visible parent container's right or bottom edge — including
   nodes, callouts, zone-labels, section-subtitles, node-question
   subtitles?
3. **Arrow-path-vs-text crossing.** Does any arrow line (the path,
   not the label) cross OVER a text element along its route?
4. **Element-vs-element overlap.** Does any pair of nodes,
   callouts, or labelled regions partially overlap each other in
   the rendered pixels? Pixel inspection is required — element
   bbox math can read OK in JSON while the PNG shows pixel overlap
   due to padding or stroke width.

If any of (1)–(4) is present, the verdict is at least ITERATE
regardless of whether the rule-based axes (modality, color, framing,
question-as-answer, ground-problem terminus) are clean.
Geometric defects FAIL even if the content is correct — they make
the diagram unreadable, which is a higher-priority failure than any
content nuance.

The critic is also to recommend, alongside the verdict, that the
harness adds the corresponding **upstream fix** so that future agent
runs cannot ship the same defect — per the strong-vs-weak ask rule
below. A verdict of "ITERATE: zone-overlap on multi-view" without an
upstream-fix ask is itself an incomplete grade.

**For STRUCTURAL defects, recommend prompt-level fixes only as last
resort; prefer fixes at the SKILL layer or the renderer.** Slate runs
on the upstream `excalidraw-mcp` (we do not patch the MCP wrapper). The
levers we control are:

1. **`src/SKILL.md`** — durable design rules the agent reads on every
   run. Best place for "callouts must size to content," "math goes in
   big text + colored box, not shapes," "use the subject's vocabulary."
2. **`SYSTEM_SUFFIX` in `src/pipeline.ts`** — Slate-specific layer on
   top of the SKILL. Best place for "ground-problem framing,"
   "component-as-answer questions," and any Slate-specific UX
   constraint.
3. **`resolveSceneFromInput` in `src/pipeline.ts`** — the only
   "wrapper" we have. Filters pseudo-element types, applies
   restoreCheckpoint deltas. If a rejection makes sense (e.g. a
   structurally invalid element type), it goes here.
4. **`Whiteboard.tsx` render path** — last line of defense for visual
   defects that survive the agent (truncation, overflow visualization,
   focus state).

For each defect class, recommend the highest-leverage fix:
- WEAKER ask: "the SYSTEM_SUFFIX should add a rule that text must fit"
  (asks the agent, via prose, to do the right thing on this paper).
- STRONGER ask: "the SKILL should add a durable section on container
  fit with a worked counter-example" (fixes it across all future runs).
- STRONGEST ask: "the renderer should add a wrap-aware text overflow
  visualisation so that bad output is visible to the user" (makes the
  defect undeniable when it does occur).

The critic should default to the STRONGER or STRONGEST ask for any
defect with a geometric definition. Prompt-level recommendations are
reserved for *content-quality* defects (term-of-art, question framing,
depth of explanation, modality choice) where the SKILL layer is the
right home.

---

## Reference image (the floor, not the ceiling)

The reference quality bar is a multi-section whiteboard where each
section uses a *different* visual modality appropriate to its content.
A single-row pipeline of plain boxes is below that bar regardless of
clean-typecheck or "looks fine" feel. The SKILL playbook
(`src/SKILL.md`) shows what the bar looks like — the agent has it on
every run. The critic's job is to confirm it lands.

## Design grammar (user-stated)

### 1. Background zones group meaning, not shapes

A whiteboard's first design move is to identify the 2–3 conceptual
regions of the explanation and drop those as faint background zones
(roughly 30% opacity). Then place labeled shapes inside the zones.
The zones do the categorization so the inner shapes don't have to.

Examples of valid zone framings:
- "INPUTS / EMBED-PROJECT / OUTPUT"
- "UI layer / logic layer / data layer"
- "Input / Process / Output"

Grading consequence: a render with no zones, or with zones that don't
correspond to actual conceptual regions of the explanation, is
ITERATE or REJECTED depending on severity.

### 2. Color carries semantic load

The color mapping is fixed:

| Color | Role |
|---|---|
| Blue | input / source |
| Green | success / output |
| Amber / yellow | notes / decisions |
| Red | error / critical |
| Purple | processing / special |

Every shape's fill is making an assertion about its role. Picking
colors aesthetically (e.g. "this section is purple because it goes
with the purple zone above") is wrong — colors are labels.

Grading consequence: a render where colors don't match the role of
their shapes is ITERATE. A render where every shape is the same color
is REJECTED unless the explanation genuinely has no role distinctions.

### 3. Progressive emission (call order = streaming order)

The agent makes multiple `mcp__excalidraw__create_view` calls so the
canvas updates progressively. Within each call, elements should be
ordered narratively: shape, then its label, then its outgoing arrow,
then the next shape. NOT "all rectangles first, then all text, then
all arrows."

This is what makes the canvas read like building an idea step by
step — the user watches the diagram being constructed, not a final
state appearing all at once.

Grading consequence: detectable from the call ordering across the
stream and the element ordering within each call. Sorted-by-type
ordering is ITERATE.

### 4. Three modes; pick the right one for the content

The Excalidraw guide doesn't formally name these but the examples
in the SKILL train recognition:

- **Structured mode** — formal columns, dashed lifelines, labeled
  message arrows. For parallel actors exchanging messages.
- **Animation mode** — multiple `create_view` calls with deletes and
  re-adds to fake motion. For things that change over time.
- **Plain whiteboard mode** — labeled shapes and arrows scattered
  with intent. For free-form explanations with annotations.

A render must pick the mode that matches the content. A render
that uses plain mode for a sequence-of-messages explanation, or
structured mode for a definition-with-parts, is ITERATE.

### 5. Format-choice decision rules (user heuristics)

The user's mapping (extracted from their feel; the SKILL has worked
examples):

| Content shape | Right format |
|---|---|
| Sequential (clear before/after) | Flow with arrows L→R or top→bottom, zones for phases |
| Parallel actors talking to each other | Sequence diagram (lifelines + messages) |
| Nested / hierarchical structure | Containment via zones, **not** arrows |
| Definition / concept with parts | One big illustration in the middle, callouts pointing at it |
| Changes over time | Animation mode (delete + redraw) |
| Formula / piece of math | Big text element + colored box around the right-hand side, **no shapes** |

Grading consequence: the critic must judge whether the agent picked
the right format for the content. Format mismatch (e.g. boxes-and-
arrows for a math formula) is ITERATE; persistent format mismatch
across the canvas is REJECTED.

## Carry-forward rules from prior user critiques

- **Plainness is a downgrade signal**: a whiteboard that explains
  everything as boxes-and-arrows is automatically ITERATE or
  REJECTED.
- **Modality must adapt to content**: a canvas with multiple
  sections where all use the same modality is ITERATE — even if
  each individual section is internally clean.
- **Source-side claims do not substitute for visual judgment**.
  "Typecheck clean" is necessary but not sufficient. The critic's
  job is the visual + cognitive grade source-side checks can't
  capture: does the diagram *explain*? Does it adapt? Does it look
  like something a human teacher would draw on a whiteboard?
- **Section numbering must be sequential — 1, 2, 3, not 1, 3, 5**.
  The whiteboard's own section numbers are a presentation device.
  Sequential numbers signal a complete arc; gaps signal "you
  skipped something." Grading: any gap in section numbering is
  ITERATE.
- **Equations must be explained in depth — every symbol, intent,
  and mechanism**. A bare equation with a one-line caption is not
  enough. For each equation:
    - State what the equation IS (name, role: loss / update rule /
      sampling step / etc.)
    - State its INTENT (why this exists in the paper, what it
      computes, what failure mode it addresses)
    - DECOMPOSE every symbol on both sides — name it, state its
      type / shape, explain its role in the formula
    - Where multi-equation, state how they CHAIN (output of one
      feeds input of the next)
  Bare equations downgrade to ITERATE. Whitespace is not the
  enemy here; under-explanation is.
- **Containers must fit their content — no oversized empty
  boxes**. Callouts, zones, and section frames must size to their
  content with consistent padding (~24-32 px), not arbitrary
  fixed dimensions. A green KEY IDEA callout that is 600 px wide
  for 200 px of text is wrong. Grading: visible whitespace > ~50%
  of container area is ITERATE.
- **Layout must respect global bounds — local elements that
  overflow globally are bugs**. Every element's bounding box must
  sit inside its parent section's bounding box; multi-equation
  explanations on a single line that overflow the canvas are
  FAIL-class. Wrap, line-break, or split into per-equation
  paragraphs. Grading: any element extending past its section's
  right/bottom edge is ITERATE.
- **Two-pass mental model — plan content first, then place with
  global-layout discipline** (architectural critique 2026-04-27,
  user verbatim: *"our method for generating charts is separated
  into two different parts: 1. When we decide the core logic as
  to what you want to put. 2. The next step when we actually go
  ahead and create the charts. When creating the charts, you
  have to keep these layout principles, global consistency, etc.,
  in mind."*).
  An ITERATE-class signal that the agent skipped the planning
  pass is: visible inconsistency in section sizing, a section
  that runs off-canvas, a callout with wrong proportions, an
  equation annotation that overflows. These are evidence the
  agent was emitting tool calls without first reasoning about
  global layout. (In Slate's pipeline, this happens entirely
  inside the agent's own reasoning — there is no separate
  planning pass.) Grading: persistent layout inconsistencies
  (≥2 sections with proportion or overflow problems) is REJECTED
  — the agent didn't plan before placing.
- **Text inside any container — including callout bodies — must
  stay inside the container's visible bounds** (verbatim user
  critique 2026-04-27: *"the text in the box three is coming out
  of the box. That should not happen. We should have structural
  ways to make sure that this does not happen."*). Coverage must
  extend to ALL text-in-container element types, regardless of
  how the underlying primitive is emitted. Grading: any visible
  text-overflow past a container's right or bottom edge is
  FAIL-class regardless of element type or how the agent chose
  to emit it. Slate's primary lever here is the SKILL playbook
  (which already covers wrap-aware sizing) — if a real defect
  shows, the recommendation is to strengthen the worked example
  in `src/SKILL.md` and add a render-side overflow visualisation
  in `Whiteboard.tsx`.
- **Components must be framed as answers to ground-problem
  questions, not as standalone parts** (verbatim user critique
  2026-04-27: *"when we are listing the modules or different
  components, it might help to understand things in a way that
  asks what is the answer that each component is answering. For
  example… cross-attention to dyno v3 patches helps us answer:
  what does the 3D point look like in each photo? Sparse
  self-attention can help answer in this specific problem…
  how does this point relate to its neighbors? Which view should
  I trust here? … the user is very much focused and oriented
  towards how everything connects to the ground problem rather
  than just how these details are interconnected."*). Every
  whiteboard node, callout, and inline annotation that names a
  component, mechanism, equation, or sub-system MUST be paired
  with a visible question that the component answers — and that
  question must trace back to the paper's ground problem (the
  end goal the paper is solving), not to another component.
  Examples:
    - Wrong: node label "Cross-attention to DINOv3 patches" with
      no question, OR with the question "how does it interact
      with the encoder?" (component-to-component, no ground
      problem terminus).
    - Right: node label "Cross-attention to DINOv3 patches" with
      visible subtitle/annotation "→ what does this 3D point
      look like in each photo?" (question terminates at the
      paper's reconstruction goal).
  Grading: ITERATE if any named component lacks a visible
  question-as-answer framing. ITERATE if questions connect only
  to other components instead of to the ground problem. The
  ground problem must be ascertainable from the pasted content;
  the agent should declare it once at the top of the canvas (a
  thesis line, the paper's end-goal sentence) and every node's
  question must trace back to it. This is a higher bar than
  "modality matches content" — modality match is necessary but
  not sufficient; explanatory orientation toward the ground
  problem is a separate axis. APPROVED requires both. The
  durable home for this rule in Slate is the SYSTEM_SUFFIX in
  `src/pipeline.ts` (`## 2. Ground-problem framing`).

- **APPROVED**: meets the reference-image bar. Multi-section,
  modality-matched-to-content, clear visual hierarchy, evidence
  artefacts where load-bearing, semantic color mapping correct,
  zones present, no structural defects, ground-problem framing
  visible.
- **ITERATE**: multi-section but uneven (one section great,
  another plain; modalities match content but colors don't;
  ground problem named but a node lacks its question; etc.).
  Specific feedback required: "section 2 is plain — should use
  math-callout modality for its equation"; "color of node X
  doesn't match its role"; "node 'Sparse self-attention' has no
  ground-problem question subtitle."
- **REJECTED**: single-modality canvas; single-row layouts with
  no sections; plain boxes-and-arrows when the content has math/
  figures/temporal narratives the agent ignored; format mismatch
  across the canvas (e.g. sequence-of-messages rendered as
  flowchart); no zones; uniform color palette; ground problem
  invisible.

## Critic output format

Always emit:
1. Top 3 issues, ordered by severity (FAIL > WARN).
2. For each issue: which design-grammar rule it violates (e.g.
   "violates rule 2 — colors don't match role").
3. Verdict: APPROVED / ITERATE / REJECTED.
4. If ITERATE or REJECTED: one or two concrete next-render asks
   ("collapse the architecture box hierarchy from 7 nested rects
   to 3 + zones"; "convert section 2 to math-callout modality").
5. For each ask, the **layer it targets** (SKILL / SYSTEM_SUFFIX /
   resolveSceneFromInput / Whiteboard.tsx render path) — this is
   the upstream-fix bias from the geometric checklist above.

The implementer iterates on your asks. You re-grade. Loop closes
when APPROVED.
