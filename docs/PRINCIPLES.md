# Slate — principles

These are the rules Slate was built on. If a change you're proposing contradicts one of them, the principle wins unless you can articulate — in an issue or PR description — why it should change.

The principles are grouped by *kind*, because the kind tells you who the rule constrains:

| Category | Constrains | Example |
|---|---|---|
| **Product** | What Slate is for, and what it isn't. | "Paste anything; get a whiteboard." |
| **Design** | How the canvas looks and feels. | "The scene is editable, always." |
| **Scientific** | How the agent draws. | "Use the subject's own vocabulary." |
| **Engineering** | How the codebase is built. | "No retry logic." |

The scientific principles below are taken almost verbatim from [coleam00's excalidraw-diagram-skill](https://github.com/coleam00/excalidraw-diagram-skill), which Slate's pipeline delivers as the agent's system prompt. Read that file too — it's the playbook the agent actually uses.

---

## Product principles

- **Paste anything; get a whiteboard.** The single value prop. Text, image, PDF, mixed — any of those should produce a useful diagram on the first try.

- **The canvas is the answer.** Don't return text-about-a-diagram, don't explain in prose what could be drawn, don't narrate the diagram in words. Return the diagram itself, on a live canvas the user can edit.

- **Persist by default.** Once the user has paid the API cost (~$0.95) to generate a whiteboard, regenerating it because Slate forgot to save is a design failure. The session canvas survives app restart unless the user explicitly clicks regenerate.

- **Two distribution modes, one component.** Slate is the standalone Mac app; `fathom-whiteboard` is the npm package; both render the same React component against the same Node pipeline. A behaviour change has to happen in one place.

---

## Design principles

- **The scene is editable, always.** What the agent draws is real Excalidraw elements — not a generated PNG, not a screenshot. The user can move, rewrite, recolour, and annotate any of it without leaving Slate.

- **No frozen UI during generation.** While the agent is drawing, the chat input stays editable; the user can type the next refinement, paste an image, or abort the run. A frozen input during a 60-second agent turn is a fatigue source we don't accept.

- **Streaming over batched.** Scene updates land on the canvas as the agent emits them, not all at once at the end. Watching the diagram appear is part of the value — it teaches the user what the agent is reasoning about.

- **No emojis. No marketing superlatives.** Plain sans for everything. Slate inherits Fathom's typographic discipline; the wordmark is the only place hand-drawn type lives.

---

## Scientific principles (the SKILL)

These are paraphrased from [coleam00/excalidraw-diagram-skill](https://github.com/coleam00/excalidraw-diagram-skill); the verbatim version is at [`src/SKILL.md`](../src/SKILL.md).

- **A diagram is a visual argument about its subject.** It must show something the subject's text alone cannot.

- **Shape-of-diagram = shape-of-subject.** If they don't match, the structure is wrong. The agent does not bring its own preferred shapes.

- **Use the subject's own vocabulary.** Anything the agent invents in place of a real name is a bug.

- **Repetition without reason is noise.** When two parts of the diagram look alike, that should reflect a real similarity in the subject. When they look different, that should reflect a real difference.

- **Iterate after `create_view`.** If the structure doesn't match the subject, change it. Iterate until it does. (The pipeline allows the agent to call `create_view` multiple times in a single turn — the latest one wins.)

---

## Engineering principles

- **Tools enforce constraints; prompts only guide intent.** When a structural defect (text overflow, element overlap, missing label) shows up, the fix belongs at the tool layer (validate-then-reject inside the MCP wrapper, or inside the React component's render path), not as another paragraph of system-prompt nudging. Prompt-only fixes are local to one artefact; tool-level fixes catch the whole class.

- **No retry logic.** If something fails once, that's a signal worth reading, not a transient glitch to retry past. The only retry the pipeline has is whatever the underlying SDK / MCP transport implements; Slate adds none on top.

- **No fallbacks for things that should work.** A fallback is "this code path failed but here's a worse one we'll quietly take." Pre-empt the failure or fix the path; don't half-fail silently.

- **Isolation and investigation.** When something breaks in a multi-stage pipeline, isolate the broken stage and iterate on it in isolation — don't repeatedly regenerate from the top. For Slate: if the rendered diagram is wrong but the `create_view` JSON is correct, the bug is in the React render layer, not the agent.

- **Close the loop on output quality.** Every implementer must run their own work against a real example before declaring done. Typecheck-clean does not mean the diagram is good. The producer of an artefact (human or AI) is responsible for *looking at* what they produced before shipping it.

- **Instrument first, fix second.** Every subsystem logs entry/exit and key decisions. When a user reports a symptom, the logs should already show the cause.

---

## Non-goals

- **No retrieval-augmented generation.** No embeddings. No vector store. Slate hands the agent the pasted content directly; the agent reads it.

- **No "explain my diagram" feature.** The diagram is the explanation. Adding a "summarise the diagram in text" surface would be the prose-fallback that the canvas-is-the-answer principle exists to prevent.

- **No template library.** We tried this in the pre-pivot pipeline; it locked the agent into a small set of layouts and *suppressed* quality. The current shape lets the SKILL playbook do its job, unconstrained.

- **No multi-Pass / critic loop in the pipeline.** Pre-pivot Slate had Pass 1 (read paper into 1M context), Pass 2 (plan + emit a scene), Pass 2.5 (render to PNG, vision-critique, iterate up to 3 rounds). We threw it out because the simpler pipeline produces a tighter diagram for a fraction of the cost. If a future feature needs critic-style iteration, it gets justified per-feature, not added back as default.

- **No vendor lock-in.** Slate runs on the user's existing Claude subscription. There's no Slate-branded API key, no Slate billing, no Slate-hosted MCP that we charge for. Most whiteboard tools want a vendor relationship; Slate is a Mac app you compiled yourself.
