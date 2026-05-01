---
name: clawdslate-cog-review
description: Cognitive-psychology review for clawdSlate UX changes. Run on every team commit before merge. Cites established cognition / perception research; vetoes anything that demonstrably violates working-memory, attention, or perceptual limits. Run automatically on diffs touching the paste flow, chat input, canvas defaults, or anything visible during a long brainstorming session.
type: skill
---

# clawdSlate cognitive review

clawdSlate is a tool for **focused brainstorming sessions on dense
content** (papers, slide decks, code architectures, photos of
whiteboards). That's the load case to optimise for. Most UI
review checklists assume short transactional flows (sign up, add
to cart, search). Comprehension and sustained-attention research
applies different ceilings, and they're the ceilings this product
hits first.

This skill is the gate every UX-affecting commit passes through
before landing on `main`. The reviewer is empowered to
**APPROVE / APPROVE WITH NOTE / REQUEST REVISION / VETO** per
`TEAMS.md`. A veto must cite research, not preference.

## The core rules — in order of veto severity

### 1. Working-memory ceilings

Miller's 7±2 (Cowan's revision: 4±1 for novel chunks). The user
is reading what they pasted + watching the canvas — every
new node is a fresh chunk. Any UI element that asks them to
hold more than ~4 novel items in working memory while still
reading the canvas is a veto.

Examples:
- ✗ A diagram with 12+ unconnected nodes presented at once.
- ✗ A modal that requires reading + confirming + remembering 3
  options while a generate run is mid-stream behind it.
- ✓ A canvas chunked by zones (3-5 conceptual regions, each
  with 3-5 nodes inside). Within Cowan's chunk limit at the
  zone level.

### 2. Attention-residue from interruptions

Mark, Gudith, Klocke (2008): an interruption costs ~23 minutes
to fully recover from. Anything that interrupts mid-brainstorm
without the user explicitly initiating it is a veto candidate.

Examples:
- ✗ Auto-popping a settings panel after a state change.
- ✗ A toast that appears unprompted during a stream.
- ✓ A subtle indicator that appears post-action (after the user
  submitted a refinement). Same modality, no attention pull.

### 3. Doherty's threshold

Response latency >400 ms is perceived as the system thinking
rather than the user thinking. Any control that crosses this
boundary without an immediate visual ack should NOT be shipped
without the ack.

Examples:
- ✗ A submit button click that streams the agent's first turn
  with no in-flight state visible for >400 ms.
- ✓ Submit click that immediately renders an activity-log entry
  ("[tool_use] mcp__excalidraw__read_me"), then streams the
  drawing into the canvas.

### 4. Visual-foveal acuity

Foveal vision is ~2° of visual arc. At a typical monitor distance
(~50 cm), that's roughly 5–8 characters of acute focus. Anything
that asks the eye to read two distant regions simultaneously
violates this.

Examples:
- ✗ Critical action info in a tooltip 800 px from the action.
- ✗ A status indicator in the top-right when the action lives
  bottom-left.
- ✓ Inline activity log that appears next to (not 800 px from)
  the chat input that triggered it.

### 5. Saccadic predictability

Reading is a chain of saccades + fixations. Visual aids must
either (a) stay outside the saccadic path, or (b) move with it
predictably. Aids that jump randomly disrupt fixation.

Examples:
- ✗ Canvas elements that re-arrange themselves between
  `create_view` calls because the agent re-thought the layout.
- ✓ Progressive emission where each new call extends the prior
  layout (the canvas grows, doesn't reshuffle).

### 6. Colour signalling and accessibility

Red ≠ universally "active/error." 8% of male readers have
red-green colour-vision differences. Use of red MUST also carry
a non-colour signal (shape, motion, position).

Examples:
- ✗ A red dot that means "still streaming" with no other cue.
- ✓ A red dot + a subtle pulse animation, with the colour
  reinforcing what motion already conveys.

The whiteboard rubric's color grammar (blue=input,
green=output, amber=notes, red=error, purple=processing) is the
inside-the-canvas form of this rule. Outside the canvas (chrome,
toasts, errors) the same rule applies — never colour alone.

### 7. Choice paralysis (Hick's Law)

Decision time scales with log₂(N+1). For a casual control
surface (the chat input toolbar, the welcome screen), N > 6 is
the rough comfort ceiling for quick scanning.

Examples:
- ✗ A welcome screen with 10 example-prompts of comparable
  visual weight.
- ✓ A welcome screen with 1 paste prompt + 2-3 "try this" example
  links, total N=4.

### 8. Default-setting ethics

Defaults are de facto choices for ~85% of users (Johnson &
Goldstein 2003). Default zoom level, default chat-input position,
default activity-log expansion behavior is the value most users
will live with — the reviewer should pressure-test it as such.

Examples:
- ✗ Default zoom = 200% making the user pinch-out before
  reading anything.
- ✓ Default zoom = "fit content" — every user sees the whole
  canvas first, can zoom in by gesture if they want detail.

### 9. Components must terminate at the ground problem, not at each other

Established 2026-04-27. When the canvas names a component (a
node, callout, or annotation referencing a piece of the pasted
content), each named piece MUST be framed as the **answer to a
specific question** that traces back to the **ground problem**
(the end goal the pasted content is solving). Detail-soup
diagrams that interconnect components to other components
without ground-problem terminus read as overwhelming and
unrooted, even when each individual fact is correct.

This is encoded in clawdSlate's `SYSTEM_SUFFIX` (`## 2.
Ground-problem framing`); the cog reviewer's job is to confirm
it survives all the way to the rendered canvas.

The user's verbatim critique:
> "when we are listing the modules or different components, it
> might help to understand things in a way that asks what is the
> answer that each component is answering. … the user is very
> much focused and oriented towards how everything connects to
> the ground problem rather than just how these details are
> interconnected."

The reviewer must flag any of three failure modes in a rendered
canvas:

- **(a) Named component without a question framing.** A node,
  bullet, callout, or paragraph names a piece of the pasted
  content but does not state the question it answers. The
  component is presented as a standalone part.
- **(b) Question terminates at another component.** The
  question is present but resolves laterally — *"how does
  cross-attention interact with the encoder?"* — instead of
  resolving back to the paper's end goal. Component-to-
  component questions are detail-soup with extra steps.
- **(c) Ground problem is invisible.** The diagram contains
  no thesis line, no end-goal sentence, no statement of what
  the paper is ultimately trying to do. The reader has no
  anchor for any of the questions the components allegedly
  answer.

**This is a HARD review failure, not a soft suggestion.** When
any of (a) (b) (c) is present, the verdict is REQUEST REVISION
(or VETO if the surface is a default-shown explanation). The
reviewer rejects the diagram and asks for a re-write that:

1. Names the pasted content's ground problem explicitly (one
   sentence, visible at the top of the canvas).
2. Frames every named component as "→ what question does this
   answer?" with the question resolving back to the ground
   problem.
3. Eliminates pure component-to-component connective tissue, or
   moves it below the question-as-answer framing as supporting
   detail.

The reviewer does NOT accept "but each fact is correct" as a
defence. Correct facts assembled without ground-problem
terminus is the failure mode this rule exists to catch. The
ground problem is ascertainable from the pasted content; if
Claude produced a diagram without using it, the prompt or the
content shaping needs the upstream fix (route via the AI
scientist per TEAMS.md), not just the artefact.

This rule composes with rule §1 (working-memory ceilings):
without a ground-problem anchor, every named component is a
fresh chunk competing for working memory. The anchor lets the
reader chunk components by "things that answer X" rather than
holding each as a separate item.

## The review protocol

For each diff, the reviewer:

1. Identifies which of the 9 rules above are touched. Many
   diffs touch only one (a copy change touches §6/§7; a new
   keyboard shortcut touches §3/§5; a canvas-default change —
   modality, zoom, activity-log placement — touches §9).
2. For each touched rule, walks the diff line by line and
   tags one of:
     • ✓ — within the rule's ceiling
     • ⚠ — borderline, propose alternative or measurement
     • ✗ — violates with citation
3. Issues the verdict:
     • APPROVE — all ✓
     • APPROVE WITH NOTE — mostly ✓ + ⚠ that the team should
       follow up on (recorded in todo.md)
     • REQUEST REVISION — at least one ✗ but the rest of the
       diff is sound; team rewrites the violating slice
     • VETO — multiple ✗ or one ✗ on a default that affects
       all sessions; full reconsideration required

## What the reviewer does NOT do

- Aesthetic preference. "I don't like the colour" is not a
  review. "This colour pairing fails WCAG AA contrast" is.
- Code review. Logic correctness is the team's responsibility;
  the reviewer reads only the user-visible behaviour.
- Performance review. That's the SE's domain.

## Escalation

If the reviewer can't decide between APPROVE WITH NOTE and
REQUEST REVISION, kick the question to the user with the
specific tradeoff named: *"This advances the activity-log
auto-collapse at the same speed regardless of stream length,
which violates §1's chunk count for streams >5 turns. Option A
(collapse after 3 turns): cite Anderson 2017. Option B (never
auto-collapse): cite no clean source, would need user testing.
Recommend?"*

## The reviewer's posture

Empathetic to the team. Many cognitive constraints are NOT
intuitive — the team isn't being careless when they ship a
7-icon header, they just don't have Hick's Law internalised.
Frame requests as "this is what the research says about
the load case" rather than "you got it wrong."
