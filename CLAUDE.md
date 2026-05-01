# clawdSlate — Core Principles

clawdSlate is a standalone Mac app for paste-driven whiteboard brainstorming with Claude. Drop in a paragraph, an abstract, an image, or a PDF — watch the agent draw an explanatory diagram on a live Excalidraw canvas you can edit alongside. The same React component ships as the `fathom-whiteboard` npm package; Fathom (the research-paper reader) embeds it as a per-paper tab. This document collects the design and engineering principles clawdSlate is built on. Every principle below comes directly from instructions given by the user during construction; nothing here is speculative.

This file is the source of truth for future changes. If a new feature contradicts anything below, the principle wins unless the user explicitly revises it.

**For Claude Code / agents**: this file is the authoritative brief for the codebase. Read it in full before making behavioural changes. The rules in §0 (next section) override everything else, including the default agent behaviours.

---

## 0. Working with the user

These rules shape *how* you (Claude Code, or any agent) collaborate on
clawdSlate. They override any conflicting default behaviour.

- **Every instruction is executed.** If the user gives an instruction
  and you decide to prioritise a different task first, record the
  deferred instruction in `todo.md` at the repo root *immediately*.
  Resume `todo.md` top-to-bottom once the current task finishes, and
  tell the user you're doing so.

- **Queuing requires a `todo.md` entry — every time, no exceptions.**
  Any phrase that defers work — *"queued for v0.1.X"*, *"Phase 3 will…"*,
  *"follow-up"*, *"next session"*, *"deferred to…"*, *"shipping
  later"* — appearing in a commit message, release note, response,
  or skill must have a corresponding `todo.md` entry committed
  alongside. The rule applies **if and only if you are actually
  queuing**. Don't pad `todo.md` with hypothetical future work that
  isn't a real commitment; do log every real commitment so a future
  session can pick it up. A commit that promises follow-up but
  ships no `todo.md` line is incomplete — fix the commit before
  pushing.

- **End-to-end verify shipping paths.** Distribution, install, update,
  and first-run flows must be tested on a real version bump before
  being declared done. "The code looks right" has failed Fathom (the
  upstream project) at least once (Squirrel.Mac / ad-hoc signing
  incident) — clawdSlate inherits that lesson by construction (no Squirrel,
  one-script install/update via `install.sh`), but the verification
  rule still holds: don't rely on "the code looks right."

- **Agent harness is a first-class artefact.** clawdSlate isn't just
  shipped software; it's shipped software plus the agent tooling that
  tests and ships it. New gestures, new controls, new release flows
  all require updating the corresponding `.claude/skills/` file so the
  next agent session inherits the capability.

- **Design-pattern check runs on every controls change.** When you
  touch keyboard shortcuts, paste flow behaviour, refinement chat
  semantics, or the install/update flow, invoke the `clawdslate-ux-review`
  skill (or its checklist) before committing. UX regressions are
  regressions.

- **Communication matches the dev workflow.** clawdSlate is a dev-first
  tool — we build, ship, and update it via terminal. Our external
  communication must reflect that ordering: the terminal install is
  the *primary* path everywhere it shows up (README, docs home,
  INSTALL guide, release notes, in-app tour). The DMG is a text
  link to a Mac-install section — never the hero CTA, never
  accompanied by an app-store-style icon. Every contributor surface
  should read "we use our own CLI; here is that CLI." See
  `.claude/skills/clawdslate-communication.md` for the typographic +
  copy rules that enforce this.

- **Pre-release QA is mandatory.** Every release runs through
  `.claude/skills/clawdslate-qa.md`'s canonical flow before the tag is
  pushed. Typecheck is free; state+logs check is cheap; screenshot
  grading is the critical step that catches "canvas empty after
  generate" and its cousins. Do not declare a release done on the
  basis of "the code looks right" — that has now misled us multiple
  times across Fathom and clawdSlate.

- **Reported-failure retrospection.** When the user reports that a
  fix we've already shipped isn't actually working for them, treat
  it as a systemic failure of our agent harness — not a retry prompt.
  Specifically:
  1. **Retrospect honestly, out loud.** What failure mode did we
     match the bug to, and what mode did we miss? Was our mental
     model of the underlying system (Electron asar, Gatekeeper,
     Claude Agent SDK, Excalidraw canvas) wrong?
  2. **Add instrumentation before re-fixing.** A future recurrence
     has to be diagnosable from the log file alone — the user
     doesn't have DevTools open at the moment of frustration.
     Debug flags are fine.
  3. **Capture the new pattern.** If you learned a design rule —
     "the SDK's cwd default is unsafe inside asar; pin it" — it goes
     into this file or into the relevant `.claude/skills/*` file so
     the next session inherits it. Skills are the harness; treat
     them as code.
  4. **Skill-level detectable.** Ask: could `clawdslate-ux-review` catch
     this regression just by reading the diff? If not, add the rule.
     Same for `clawdslate-e2e-test` — is there a flow that would have
     exposed this? Add it.

- **Agent harness as a first-class product.** We're not only building
  a whiteboard app; we're building the team of agents + skills + hooks
  that builds, tests, and ships it. Treat every retrospection as an
  opportunity to improve that harness. If two sessions in a row hit
  the same shape of problem, that's a missing skill or a missing
  instrumentation — fix the harness, not just the symptom.

- **The orchestrator is a CEO, not an IC. Route work; don't do it.**
  (Sharpened 2026-04-27 in Fathom; applies verbatim to clawdSlate.) The
  orchestrator's job is to dispatch teammates, set quality bars,
  route critiques, retire members — not to read PNGs, edit code, run
  smoke, or grade renders. Even when the work looks like it would
  take 30 seconds and routing through a teammate looks like overhead,
  **always route**. The orchestrator-as-IC failure mode produces
  three losses: (1) the team-channel context disappears, (2) the
  iteration loop's separation-of-concerns collapses, (3) the
  orchestrator burns context and gets blind to what's actually
  happening. Concretely: if the next instinct is "I'll just X" —
  STOP and send it to the right teammate instead. If the right
  teammate doesn't exist, spawn one; if they're broken, respawn them;
  if the team-channel routing is broken, fix the routing. Never
  substitute orchestrator-direct work for missing/broken team
  mechanics — that's the workaround-vs-theater rule (TEAMS.md §3)
  applied to coordination.

- **Teammates for high-level work; sub-agents are an internal tool.**
  Established 2026-04-25. When dispatching feature implementation,
  audits, reviews, research streams that may need follow-up, or
  anything that should retain context across a multi-turn iteration:
  use **named teammates** (first call `TeamCreate({team_name, ...})`
  to create the team, then spawn members with `Agent({team_name,
  name, ...})` so they inherit the team channel and `SendMessage`
  works — both halves are required; the `name` alone is not enough)
  — the structure documented in `.claude/TEAMS.md`. One-shot
  sub-agents (the `Agent` tool with no `name`) are something a
  teammate may use *internally* to parallelise their own work — that
  is the teammate's call, not the orchestrator's. **The rule for the
  orchestrator (this conversation): every high-level implementation,
  audit, review, or research dispatch goes to a teammate.**

- **Never engineer around failure — diagnose it.** (CORE principle,
  established 2026-04-27, sibling to **Isolation and investigation**.)
  When something fails — a smoke test stalls, an API call rate-limits,
  a render comes back wrong — the wrong instinct is to *engineer
  through it*: add retry logic, exponential backoff, fallbacks,
  defensive bandages, "robustness" layers. Every retry hides signal;
  every fallback rationalises around the broken thing instead of
  confronting it. Real fix work is the opposite: **sit down, isolate,
  root-cause.** Concrete consequences:
  - **No retry logic.** If something fails once, that's a signal
    worth reading, not a transient glitch to retry past. If it's
    truly transient, it's the platform's job, not ours. The only
    legitimate retry I will write is one the underlying platform's
    contract explicitly requires (e.g. fetching with a documented
    `Retry-After` header against a documented 429 ceiling) — not
    speculative defense against unknown intermittency. clawdSlate's
    pipeline embodies this: there is **zero** retry logic in
    `src/pipeline.ts`; if `create_view` is called zero times, the
    caller decides whether to retry, not the library.
  - **No fallbacks for things that should work.** A fallback is
    "this code path failed but here's a worse one we'll quietly
    take." Pre-empt the failure or fix the path; don't half-fail
    silently. Counter-example we rejected: an early clawdSlate version
    auto-substituted a hand-authored placeholder scene when
    `create_view` returned no elements. The right answer was to
    surface the empty state to the host and let it decide.
  - **No "robustness" layers around symptoms.** When a symptom
    surfaces, ask: would I write this code if the underlying thing
    worked? If no, I'm engineering around failure. Delete and start
    over. Examples: "would I have written this 9-attempt retry if
    the API never throttled? No → it's symptom-layer." "Would I
    have added `try/catch + log + continue` here if errors were
    impossible? No → it's hiding signal."
  - **The discipline: STOP, isolate, root-cause.** When something
    fails, sit with it. Build a small reproduction that doesn't
    require the full pipeline. (See **Isolation and investigation**
    below.) Look at the failure mode honestly — what is it telling
    me? What's the *one* thing that would have to be true for this
    to work? Only after the root cause is identified and named do
    I edit code. If the root cause turns out to be external
    (rate-limit, account quota, OS-level), the fix is operational,
    not architectural.

- **Isolation and investigation** (CORE principle, established
  2026-04-25). When something is broken in a complex pipeline,
  **isolate the broken part** and iterate on it alone. Don't
  repeatedly rebuild the whole app, regenerate expensive AI outputs,
  and re-test end-to-end when the bug is in one downstream stage.
  For clawdSlate: if the rendered diagram is wrong but the `create_view`
  JSON is correct (saved to disk), the bug is in the
  `<Whiteboard>` render layer or the renderer's
  `convertToExcalidrawElements` step — debug there with a saved
  scene, no API calls. If the JSON is wrong, the bug is in the
  agent or the prompt — debug at the prompt layer with cached
  inputs, not by re-running generation $0.95 at a time.
  - The same shape applies anywhere: a multi-stage process whose
    output is wrong should be debugged by isolating each stage.
    Save each stage's output to disk; build per-stage CLIs that
    consume one stage's output and produce the next; iterate on
    the broken stage in isolation; integrate at the end.
  - Anti-pattern this prevents: "the diagram is bad → rebuild app
    → regenerate ($0.95) → look → still bad → tweak prompt →
    rebuild → regenerate ($0.95) → look → still bad → ..." Five
    iterations like that is $4.75 of API spend and an hour of
    build cycles, all to debug a 50-line render function. Isolating
    the render takes 30 seconds per iteration and zero API spend.
  - This composes with the close-the-loop principle: close-the-loop
    says "look at the output before declaring done"; isolation says
    "when looking reveals a bug, isolate the broken stage and
    iterate there." The two together are the development model.

- **AI agents close their own visual loop too** (established
  2026-04-25). The close-the-loop principle below applies to the
  *implementer team* (Claude Code agents shipping code). It also
  applies to **AI agents inside the product** that generate visual
  artefacts (diagrams, images, layouts). For clawdSlate this is less
  load-bearing than for Fathom (Fathom shipped an in-product Pass
  2.5 visual self-critique loop; clawdSlate threw it out because the
  simpler pipeline produced better diagrams in fewer turns). But
  the principle still applies if a future clawdSlate feature
  reintroduces a critique stage: the AI that emits the JSON cannot
  trust that JSON until it has *seen* the rendered output and
  judged it against the spec. Generation-without-looking is a
  process failure regardless of whether the producer is a human
  teammate or an in-product Claude call.

- **Team-orchestration rules live in `.claude/TEAMS.md`** (established
  2026-04-26 in Fathom; ported to clawdSlate 2026-04-30). All standing
  rules for how the orchestrator runs the team — visual-artefact
  iteration loops, critics-as-user-proxies, signal-equivalence vs
  theater, team hygiene (≤6 active members), standup polling,
  implementer discipline (§6), QA verification discipline (§7) —
  are documented in `.claude/TEAMS.md` "Workflow rules" section.
  Read that file when dispatching teammates, spawning critics,
  retiring members, or making the workaround-vs-fix call.
  CLAUDE.md is the principles index; TEAMS.md is the operational
  playbook for the agent harness. (Critic rubrics live separately
  at `.claude/critics/<name>.md`; that file is the durable home for
  any standing rubric a critic teammate must inherit at spawn.
  clawdSlate ships one rubric, `whiteboard.md`, since the whiteboard IS
  clawdSlate.)

- **Impl teammates diagnose, then STOP — no edits without explicit
  task assignment, no mutation of user state ever** (CORE,
  established 2026-04-28, full text in TEAMS.md §6). Investigation
  dispatches return a structured report; the orchestrator decides
  whether and where to apply a fix. The user's live
  `~/Library/Application Support/clawdSlate/sessions/last/`, build
  artefacts, logs, and pasted content are read-only from impl
  teammates. A single edit-before-task-assigned event triggers
  retirement.

- **QA teammates verify the FINAL USER-VISIBLE PRODUCT, headless,
  never on the user's screen** (CORE, established 2026-04-28, full
  text in TEAMS.md §7, user verbatim: *"QA's main purpose is not to
  check the logic; it's to check whether the final product is
  working or not. And they should ideally do that in a headless
  manner or by not disrupting my current screen, because I might be
  on another window as well doing something. They can use
  AppleScript or whatever they want."*). Acceptable QA = launch an
  isolated clawdSlate against `/tmp/clawdslate-test-<hash>` user-data dir,
  drive via AppleScript / Electron remote debugging /
  Playwright-electron, position off-screen or hide. Unacceptable QA
  = grading source-code logic without driving a running instance,
  taking focus on the user's screen, mutating the user's live
  state. Source-code claims do NOT close bugs; observed
  user-visible behavior does.

- **Spawned teammates need the team channel, not just a `name`**
  (lesson learned 2026-04-26). When using the `Agent` tool to spawn
  a teammate, passing only `name` is insufficient — the resulting
  agent gets a `general-purpose` sub-agent toolset that does NOT
  include `SendMessage`, so they can't communicate back to the
  orchestrator or each other. Symptom: spawned agent reports back
  "No SendMessage tool registered in this session" or simply goes
  idle without delivering work. Fix: the orchestrator must first
  call `TeamCreate({team_name, ...})` to create a team, then spawn
  members with `Agent({team_name, name, ...})` so they inherit the
  team channel.

- **Standing approval for routine in-product Claude spend**
  (established 2026-04-25 in Fathom). The user has explicitly
  granted standing approval for the whiteboard generation pipeline
  (~$0.95/paper one-time + ~$0.10–$0.30/refinement). Sub-agents
  that produce visual artefacts via the clawdSlate pipeline do not
  require per-spend confirmation. *New* AI features that introduce
  a different cost profile (e.g. cross-paper queries, video
  generation, model upgrades that change pricing) still require a
  fresh consent prompt before first use.

- **Close the loop on output quality, not just functionality**
  (established 2026-04-25). When AI teammates ship software the
  user sees the *output*, not the source. A typecheck-clean build
  that produces a cluttered diagram, a refinement that ignores the
  canvas, a paste flow that swallows the input is **not** done —
  even if every test passes. Therefore:
  - **Every implementer teammate must run their own work against a
    real example before declaring done.** Render the diagram against
    a sample paper or pasted snippet. Look at the rendered output.
    Iterate on quality. Synthetic tests don't substitute for "I
    looked at what the user will see."
  - **A separate quality-verifier teammate may do the looking** if
    the implementer is too close to their own work. The verifier
    drives the app (via the test harness or manual paste), captures
    the visible output (screenshots, log tail, scene JSON
    inspection), grades against the spec's quality bar, and sends
    feedback back to the implementer.
  - **The PM (this conversation) does NOT declare a feature live
    until the close-the-loop pass has happened.** A teammate's
    "typecheck clean and build succeeds" is necessary but not
    sufficient.
  - **Iteration is expected, not a sign of failure.** First render
    of a feature is allowed to look wrong. What's not allowed is
    shipping it without looking.

- **Observability and methodology docs are part of the product**
  (the **AI-built-product principle**, established 2026-04-25).
  When AI is the implementer and the user is the PM, the user does
  not read the source. They read the product, the docs, and the
  logs. Therefore:
  - **Every non-trivial subsystem ships with a methodology
    document** under `docs/methodology/` that explains *how it
    works* — the pipeline, the prompts, the design decisions, the
    failure modes — in plain language, not as a code reference. The
    user must be able to read that doc and reason about whether the
    approach is correct without opening any `.ts` file. clawdSlate's
    methodology lives at [`docs/methodology/index.md`](docs/methodology/index.md).
  - **Every non-trivial subsystem ships with structured logging the
    user can see** — both renderer-visible activity log and
    DevTools console. When something misbehaves, the user inspects
    logs and the doc, not source code, to understand what happened.
  - **Documentation precedes code; logging precedes documentation.**
    When we add a feature, the methodology doc and the logging
    hooks land in the same change as the implementation. Skipping
    either is a process failure, not just a polish gap.
  - **Implementer agents must be told this.** When the PM dispatches
    an implementer, the brief must include "ship the methodology
    update + structured logs alongside the code." A successful build
    that has no doc + no logs is incomplete.

- **Local-only context.** At session start, read every `.local/*.md`
  file if the directory exists. `.local/` is gitignored and holds
  the author's working notes — operational rules, dev-machine
  instrumentation, release timing preferences — that never belong
  in the public repo. Content in `.local/` supersedes defaults in
  this file when they conflict. Never reference `.local/` content
  by quote or detail in any tracked file, commit message, or
  release note; a neutral pointer (like this bullet) is the only
  permitted leak.

---

> **Categories of principles, and how to read this file.**
>
> Principles below are split into four groups so a reader can find the
> *right* kind of guidance fast. The four kinds:
>
> - **Product principles** — what we're building, for whom, and why
>   (§1). Mission-level. These outlive any specific UI.
> - **Design principles** — how the product feels, looks, and reacts
>   (§2). Cover canvas behaviour, paste flow, refinement chat,
>   typography.
> - **Scientific principles** — how the AI grounds itself in the
>   pasted content (§5). Cover the SKILL prompt, the SYSTEM_SUFFIX,
>   the no-RAG stance, ground-problem framing.
> - **Engineering principles** — how the codebase is built and
>   maintained (§8). Cover diagnosis, instrumentation, persistence,
>   release discipline.
>
> Communication principles (voice, copy, typography enforcement) live
> in `.claude/skills/clawdslate-communication.md` rather than this file
> because they're routinely consulted as a checklist by the agent
> harness when copy or visuals change.

## 1. Product principles

- **Paste anything; get a whiteboard.** The single value prop. Text,
  image, PDF, mixed — any of those should produce a useful diagram
  on the first try. Every product decision derives from this.

- **The canvas is the answer.** Don't return text-about-a-diagram,
  don't explain in prose what could be drawn, don't narrate the
  diagram in words. Return the diagram itself, on a live canvas the
  user can edit. When a feature is in tension with this — e.g. an
  "explain my diagram" panel that paraphrases the canvas back to the
  user — the principle wins.

- **The reader should never have to leave the surface.** What
  Fathom calls "never leave the document" clawdSlate phrases as "never
  leave the canvas." The chat input, the activity log, the
  refinement loop — all sit alongside the canvas, never behind a
  modal, never in another window.

- **Persist by default.** Once the user has paid the API cost
  (~$0.95) to generate a whiteboard, regenerating it because clawdSlate
  forgot to save is a design failure. The session canvas survives
  app restart unless the user explicitly clicks regenerate. (User
  verbatim from Fathom, transferred to clawdSlate: *"Once I have
  generated the whiteboard, the whiteboard should be there even the
  next time when I open it. I shouldn't have to remake it. We
  should save the whiteboard, and unless the user clears the
  whiteboard, we should not delete that whiteboard."*) The ONLY
  paths to deletion are: (a) the user explicitly clicks "Clear" /
  "Regenerate"; (b) the user manually deletes the session dir.
  Anything else is a bug.

- **Two distribution modes, one component.** clawdSlate is the
  standalone Mac app; `fathom-whiteboard` is the npm package; both
  render the same React component against the same Node pipeline.
  A behaviour change has to happen in one place. Fathom (the
  research-paper reader) embeds the same npm package as one of its
  per-paper tabs.

- **Paste is the cognitive entry point.** The user pastes content,
  hits Return, the agent draws. There is no "set up a project,"
  no "choose a template," no "configure the diagram type." The
  fewer decisions before the first canvas, the better.

- **Refinement is grounded in the canvas + the source.** Each
  refinement turn sees the current scene plus the original pasted
  content. The agent doesn't drift to a different topic; it
  iterates on the existing diagram for the existing source.

- **Cost lives in element interactivity, not word count.** A
  diagram is expensive when many entities depend on each other
  simultaneously. When the agent decides what to highlight, what
  to elaborate, or where to draw the reader's attention, it should
  weight inter-symbol coupling and unstated dependencies, not paste
  size. (Backed by Sweller, Chen & Kalyuga 2010 on element
  interactivity.)

- **Behavior change needs forcing functions, not nudges**
  (established 2026-04-25 in Fathom). When the goal of a feature
  is to *correct* a user's behavior — not just enable a new one —
  gentle prompts and optional surfaces fail by design. The user
  will skip the optional purpose anchor; they won't press the
  optional note key. If the behavior we're trying to encourage is
  one the user has already failed to do on their own, an opt-in
  scaffold cannot fix it. The design must instead create a
  **forcing function**: a low-cost surface the user *measurably
  interacts with* as a side effect of the behavior we want, not
  as a separate decision. clawdSlate's example: the chat input lives
  next to the canvas — typing a refinement is the side-effect of
  thinking about what to change, not a separate "open the
  refinement panel" decision.

- **AI-built product, audited via methodology + logs.** clawdSlate is
  built by AI agents working with one human PM. The PM does not
  read the source. They read the product, the methodology page,
  and the activity log. Therefore: every non-trivial subsystem
  ships with a methodology page (in `docs/methodology/`) and
  with structured logging visible in the running app. See §0
  "Observability and methodology docs are part of the product."

## 2. Design principles

These are about *feel* — how clawdSlate looks, moves, and rewards the
user's actions. Apple-level smoothness is the bar.

### 2.1 The canvas is editable, always

What the agent draws is real Excalidraw elements — not a generated
PNG, not a screenshot. The user can move, rewrite, recolour, and
annotate any of it without leaving clawdSlate. The agent's output is
the user's starting point, not the destination.

- After a generate run, the canvas is *theirs*. Refinements add
  to it; manual edits override the agent. The agent doesn't
  re-flow what the user has placed.
- The Excalidraw editor's full capabilities (libraries, the
  shape palette, text formatting, image insertion) are
  available. We don't strip the editor down to a "view mode."

### 2.2 No frozen UI during generation

While the agent is drawing, the chat input stays editable; the
user can type the next refinement, paste an image, or abort the
run. A frozen input during a 60-second agent turn is a fatigue
source we don't accept.

- Generation streams elements progressively. The canvas updates
  as `create_view` calls land, not all-at-once at the end.
  Watching the diagram appear is part of the value — it teaches
  the user what the agent is reasoning about.
- Abort is one keystroke (Esc) or one click. The pipeline
  cancels via `AbortController`; the partial scene is
  preserved.

### 2.3 Streaming over batched

Scene updates land on the canvas as the agent emits them, not
all at once at the end. The agent makes multiple
`mcp__excalidraw__create_view` calls; each one extends the
previous scene. The user sees the diagram being built — that's
both a debugging affordance (you can tell what the agent is
thinking) and a cognitive affordance (the diagram comes
together as a sequence of revealed thoughts).

### 2.4 Apple-level feel

- **Apple-level quality.** Generation must feel smooth and
  continuous, not a click-through wizard. Avoid any interaction
  that feels "very manual or very step-by-step."
- **The experience teaches itself.** A user should never need to
  read documentation to know what to do next. The DMG window
  explains how to install. The first launch shows a paste prompt
  with placeholder text. The chat input explains itself by being
  a chat input. If a step depends on the user finding a README,
  we have failed the design.
- **Simple, minimal options, impactful.** Every control earns its
  keep. No settings dialogs, no preferences, no toggles that only
  5% of users will find.
- **Help should be discoverable.** A `?` icon revealing the
  shortcuts (or an in-app activity log explaining what's
  happening) is always present; never hide the controls behind
  experimentation.

### 2.5 Typography, controls, accessibility

- **Handwritten = voice, sans = information.** Excalifont is
  reserved for places where a human is speaking directly to the
  reader (clawdSlate wordmark, tagline, the inside of the Excalidraw
  canvas because that's the editor's font). Everything else —
  navigation, buttons, tables, code blocks, metadata, error
  text, download controls — uses system sans so it scans fast.
  Handwriting stops being special once it's everywhere; treat it
  as a scarce resource. The full enforcement rules live in
  `.claude/skills/clawdslate-communication.md`.
- **Icons explain themselves on hover.** Every icon-only or
  icon-heavy control has a `title=` (tooltip) and `aria-label`
  that names its purpose AND its keyboard shortcut.
- **Every control has a keyboard path.** The paste flow is
  ⌘V + Return; refinement is type-then-Return; abort is Esc;
  the activity log expand-collapse is keyboard-reachable. This
  is an accessibility principle first; the fact that it makes
  the app agent-testable is a secondary benefit.

## 3. Design principles — paste flow + refinement chat

- **Paste sets context; the user types the focus.** When the user
  pastes content and hits Return, the agent generates a default
  whiteboard for the content. If the user wants to focus on a
  particular angle ("focus on the loss function," "explain the
  cache architecture"), they type that as part of the initial
  message — it becomes the `focus` block in `buildUserMessage`.
- **The agent does not prompt.** clawdSlate doesn't ship pre-canned
  question buttons or "click here for a definition" controls.
  The user types what they want; the agent answers that.
- **Refinement is single-input.** A chat input with a Send button
  outside the box on the right. Always reachable, regardless of
  canvas state. No duplicate "ask" labels anywhere.
- **The agent sees the current canvas + the source.** Each
  refinement turn includes the current scene JSON + the original
  pasted content. The agent doesn't operate on hallucinated state.
- **Aborting one run does not invalidate the next.** A new
  paste/refinement aborts any in-flight stream and starts the
  new run cleanly. The user is in charge of their attention.

## 4. Design principles — canvas layout

The canvas is an Excalidraw scene, full-screen except for the
chat input strip at the bottom and the activity log strip
(collapsed by default) at the top. Specifically:

1. **Canvas first.** It occupies the majority of the window. On
   first launch (no scene, no paste yet) it shows the paste prompt
   centred, no other chrome.
2. **Activity log strip.** Collapsed by default. When the agent
   is mid-stream, the strip auto-expands to show the streaming
   text + tool calls. The user can pin it open or collapsed.
3. **Chat input strip.** Always visible, always editable. Holds
   the next refinement message. Submit = Return; Shift+Return =
   newline.
4. **Top window chrome.** Minimal — title bar, traffic-light
   buttons, no menu bar items beyond the macOS standard set.

There is no side panel, no "diagram options" panel, no
"templates library" panel. The canvas is the surface; everything
else is a thin strip alongside it.

## 5. Scientific principles — explanations and grounding quality

- **A diagram is a visual argument about its subject.** It must
  show something the subject's text alone cannot. (From the
  upstream SKILL.)
- **Shape-of-diagram = shape-of-subject.** If they don't match,
  the structure is wrong. The agent does not bring its own
  preferred shapes. (SKILL: the Isomorphism Test.)
- **Use the subject's own vocabulary.** Anything the agent
  invents in place of a real name is a bug. (SKILL.)
- **Repetition without reason is noise.** When two parts of the
  diagram look alike, that should reflect a real similarity in
  the subject. When they look different, that should reflect a
  real difference. (SKILL.)
- **Iterate after `create_view`.** If the structure doesn't
  match the subject, change it. Iterate until it does. The
  pipeline allows the agent to call `create_view` multiple
  times in a single turn — the latest one wins (composed via
  `restoreCheckpoint` deltas). (SKILL.)
- **Component-as-answer framing — every component connects to
  the ground problem** (established 2026-04-27, user verbatim:
  *"when we are listing the modules or different components, it
  might help to understand things in a way that asks what is the
  answer that each component is answering. … the user is very
  much focused and oriented towards how everything connects to
  the ground problem rather than just how these details are
  interconnected."*). When the agent lists modules, components,
  equations, or sub-systems, each piece must be framed as the
  **answer to a specific question** that traces back to the
  **ground problem the paper is solving**. This is encoded in
  clawdSlate's `SYSTEM_SUFFIX` (`## 2. Ground-problem framing`); the
  whiteboard critic rubric grades against it.
- **Use diagrams when structure matters.** Default to including
  evidence artefacts (equations, mini-tables, callouts) when
  the subject describes an architecture, pipeline, loop, or
  relationship between components. Excalidraw-style hand-drawn
  is the aesthetic — rounded rects, soft strokes, warm beige
  for the focused component, handwritten labels.
- **Ground every diagram in what the user pasted.** clawdSlate
  hands the agent the pasted content directly; the agent reads
  it. No retrieval, no embeddings, no general-purpose web
  lookup. If the diagram is wrong, the user can read the same
  source and see why.

## 6. Scientific principles — pasted content is the entire context

- **No retrieval-augmented generation. No embeddings. No
  semantic similarity.** The pasted content is the entire input
  to the agent.
- **`paper.kind === 'text'`** inlines the markdown directly into
  the user message; **`paper.kind === 'path'`** tells the agent
  where to read it from and adds `Read` to `allowedTools`.
- **No truncation.** Opus 4.7's 1M context handles ~700K tokens of
  paper before we hit the wall. The pipeline does not truncate;
  if a paste exceeds context, the SDK surfaces the limit error
  and the host can decide whether to chunk.
- **`settingSources: []`.** When the host has its own `CLAUDE.md`
  (Fathom embeds clawdSlate), that file does NOT leak into the run.
  The agent runs against exactly the prompt we authored, nothing
  else. This is a hard isolation boundary.

## 7. Scientific principles — Claude is the engine

- **Use the Claude Agent SDK** programmatically. The user's
  existing Claude CLI auth powers every call; no API key
  management.
- **The SKILL prompt is doing the heavy lifting.** Read it
  (`src/SKILL.md`). It's a 24KB design playbook the pipeline
  delivers verbatim to the model. clawdSlate's job is to deliver it
  intact and stay out of the agent's way.
- **The SYSTEM_SUFFIX is short on purpose.** It adds:
  (1) tool mechanics (`read_me` once, multiple `create_view`
  calls), and (2) ground-problem framing (every component must
  answer a question that traces back to the paper's end goal).
  Anything that would generalise across diagram subjects belongs
  in the upstream SKILL, not the SUFFIX.
- **Stream everything.** Text deltas, tool calls, tool results
  — all flow to the renderer's activity log as they happen.
  Perceived latency must be as close to zero as possible.
- **Transparency.** The user can always see:
  - The activity log: every `[tool_use] mcp__excalidraw__create_view`
    call as it lands.
  - The streaming text: every `[assistant]` block as Claude emits.
  - The cost: the `[result] turns=N usd=X` line at the end.
  - Rich diagnostic logs in DevTools (`[clawdSlate …]`,
    `[fathom-whiteboard …]`).

## 8. Engineering principles

- **Tools enforce constraints; prompts only guide intent.** When
  a structural defect (text overflow, element overlap, missing
  label) shows up, the fix belongs at a layer *we control*, not
  as another paragraph of system-prompt nudging. clawdSlate's layers
  in upstream-to-downstream order: SKILL → SYSTEM_SUFFIX →
  `buildUserMessage` → `resolveSceneFromInput` →
  `Whiteboard.tsx` render path. For each defect class, choose
  the highest-leverage layer. Prompt-only fixes are local to one
  artefact; structural fixes catch the whole class. See
  `.claude/skills/clawdslate-tool-design.md` for the worked
  application.
- **Step-by-step diagnosis before assuming.** When something
  breaks, find the failure point via logs, DOM inspection, or a
  reproducible test. Don't guess-and-check.
- **Instrument first, then fix.** Every subsystem logs
  entry/exit and key decisions. When a user reports a symptom,
  the logs should already show the root cause.
- **Trust but verify.** After any non-trivial change, run an
  independent verifier (quality-engineer sub-agent) that
  re-reads the code against the user's criteria and reports
  pass/partial/fail.
- **No flakiness in visible state.** Persistence
  (scene/paper/viewport) and chat history must be deterministic.
  If it's sometimes missing, we have a bug, not a "works most
  of the time" feature.
- **Never block the user's flow on the AI.** The chat input is
  always editable; a new submission aborts any in-flight stream.
  The user is in charge of their attention.
- **Telemetry and observability are core features, not
  afterthoughts.** Activity log (in-app), DevTools console
  prefixes, IPC traces — all exposed.

## 9. Engineering principles — persistence model

All session state for clawdSlate lives under `~/Library/Application Support/clawdSlate/sessions/last/`. This is the per-session sidecar; the "last" dir is the working session and it survives app restart.

```
~/Library/Application Support/clawdSlate/sessions/last/
  whiteboard.excalidraw           # full Excalidraw scene file
                                  # ({ type, version, source, elements,
                                  #   appState }) — round-trips through
                                  # Excalidraw's file format for free
  whiteboard.viewport.json        # last-known scrollX/scrollY/zoom
                                  # (hydrated on mount so the user lands
                                  #  where they left off)
  paper.json                      # most-recent pasted content
                                  # ({ kind: 'text', markdown, title? } |
                                  #  { kind: 'path', absPath, title? })
  assets/                         # saved attachments — image/PDF
                                  # bytes pasted by the user
                                  # (filename: <random-id>-<safe-name>)
```

The schema choices, in code:

- `app/main.ts::workDir()` returns
  `app.getPath('userData')/sessions/last`. Stable per-user, never
  changes.
- `loadScene` / `saveScene` round-trip through a wrapper object
  (`type: 'excalidraw'`, `version: 2`) so the file is also valid
  if opened directly in Excalidraw.
- `loadViewport` / `saveViewport` are independent — viewport
  changes don't cause scene saves.
- `clearSession` truncates the three files (does not delete) so a
  re-paste-and-generate cycle reuses the same disk slots.
- Asset filenames are sanitised + prefixed with a random hex id
  so a paste of `~/Downloads/Screen Shot 2026-01-01.png` doesn't
  collide with another paste of the same filename.

For the embedded host case (Fathom), the host implements its
own `loadScene`/`saveScene` against its per-paper sidecar
(`~/Library/Application Support/Fathom/sidecars/<contentHash>/whiteboard-scene.json`).
The pipeline doesn't know or care which host it's running in.

The persistence invariant: **the user's session state is sacred**
(CLAUDE.md §0). No impl agent overwrites
`~/Library/Application Support/clawdSlate/sessions/last/` from a
diagnosis dispatch. QA agents test against `/tmp/clawdslate-test-<hash>/`
isolated dirs.

## 10. Non-goals (things we have been explicitly told not to build)

- No retrieval-augmented generation. No embeddings. No
  similarity-based retrieval. The pasted content IS the input.
- No "explain my diagram" feature. The diagram is the
  explanation. Adding a "summarise the diagram in text" surface
  would be the prose-fallback that the canvas-is-the-answer
  principle exists to prevent.
- No template library. We tried this in the pre-pivot pipeline;
  it locked the agent into a small set of layouts and
  *suppressed* quality. The current shape lets the SKILL
  playbook do its job, unconstrained.
- No multi-Pass / critic loop in the pipeline. Pre-pivot clawdSlate
  had Pass 1 (read paper into 1M context), Pass 2 (plan + emit
  a scene), Pass 2.5 (render to PNG, vision-critique, iterate
  up to 3 rounds). We threw it out because the simpler pipeline
  produces a tighter diagram for a fraction of the cost. If a
  future feature needs critic-style iteration, it gets justified
  per-feature, not added back as default.
- No infinite-canvas zoom UI beyond Excalidraw's built-in pinch.
  clawdSlate uses the editor's canvas as-is; we do not layer a
  "minimap" or "zoom-to-section" overlay.
- No built-in image generation. clawdSlate explains what the user
  pastes; it does not invent imagery.
- No auto-explain. The user types the prompt; the agent answers
  that. We do not pre-generate a default response on paste alone
  unless the user explicitly hits Return without modification.
- No vendor lock-in. clawdSlate runs on the user's existing Claude
  subscription. There's no clawdSlate-branded API key, no clawdSlate
  billing, no clawdSlate-hosted MCP that we charge for. Most
  whiteboard tools want a vendor relationship; clawdSlate is a Mac
  app you compiled yourself.
- No marketing telemetry. clawdSlate doesn't phone home about what
  you paste, what you draw, or how often you use it.

---

## 11. Minor principles

These are smaller-than-major preferences — not load-bearing enough
to sit alongside Product / Design / Scientific / Engineering, but
real enough that an agent should default to them when no stronger
rule overrides.

- **Visual indicators over short status text for transient UI.**
  For UI states that resolve in milliseconds — a save flushing,
  a stream warming up — prefer a brief visual cue (spinner,
  pulse, colour shift, glyph) over a status word like "Loading",
  "Working", "Saving". Short status text adds reading load that
  the eye doesn't need for a state that's about to disappear; a
  glyph signals the same thing in roughly half the foveal-acuity
  span and dissolves into the visual rhythm without inviting
  comprehension. Cross-references:
  `.claude/skills/clawdslate-cog-review.md` §3 (Doherty's threshold)
  and §4 (foveal acuity ~2°). Counter-example: persistent state
  changes (a generate has completed, an update is ready to
  install) DO get plain English text, because the user is being
  asked to remember or act on them.

- **Logs use `[clawdSlate …]` (Electron host) and
  `[fathom-whiteboard …]` (npm package pipeline) prefixes.**
  Same lines surface in both DevTools and the in-app activity
  log. A single grep across either substrate should triage any
  user report.

- **The `clawdslate` launcher's `update` subcommand re-runs
  `install.sh`.** Don't add a separate update mechanism. One
  script, two surfaces (terminal direct + launcher subcommand).

---

## Appendix

This file's structure is modelled on Fathom's CLAUDE.md (the
research-paper reader clawdSlate was extracted from). Most of §0 is
universal AI-collaboration guidance ported verbatim because the
rules apply equally to any product built by AI agents with a
human PM. §1–§10 are clawdSlate-specific: the product, design,
scientific, and engineering principles tailored to a
paste-driven canvas-first whiteboard rather than a PDF reader.

When in doubt, the principle wins. When the principle is wrong,
revise the principle in the same commit as the code change.
