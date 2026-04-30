---
name: slate-communication
description: The single agent for Slate's voice, copy, typography, and aesthetic. Run before any change that touches user-facing words or visuals — README, docs site, in-app copy, welcome screens, update toasts, error messages, release notes, hero imagery, fonts.
type: skill
---

# Slate communication

One agent, one set of rules, for every place where Slate speaks or
shows itself to a person. Voice, copy, typography, and visual feel
are inseparable — treat them as one surface.

Not *branding*, not *marketing*. Those words imply persuasion from
outside. Slate is shipped by the person who built it for themselves,
so the communication is reporting, not selling. Keep it that way.

## When to use this skill

Invoke before any change that touches:

- README, docs site (`docs/**`), in-app dialogs, toasts, tooltips,
  menu labels, error text.
- Release notes, GitHub release title, commit message subject lines.
- The Slate wordmark, hero, icon, any visual element that's
  first-seen.
- Fonts and color choices anywhere.

## Voice rules

1. **Report, don't persuade.** Tell what is, not what should be felt.
   The reader decides. ✓ *"Paste anything; get a whiteboard."* ✗ *"The
   most powerful brainstorming experience ever."*
2. **First-person singular is allowed.** Slate is made by one
   person, and that shows. It's honest, not unprofessional. ✓ *"I
   built the canvas I wanted."*
3. **Concrete > abstract.** A specific action ("paste a paragraph,
   hit return") beats a category ("AI-powered diagram generation").
   Name the thing the user actually does.
4. **Cut before you add.** Every line earns its place. If a
   paragraph doesn't change what the reader knows or feels, delete
   it.
5. **Never use**: *blazingly fast, revolutionary, seamless experience,
   powerful, robust, elegant, state-of-the-art, next-generation,
   thoughtful, carefully crafted, designed from the ground up.* These
   are rented words. Write it again.
6. **Never market in commit messages or release notes.** "v0.1.9:
   paste prompt placement, refinement abort, install.sh PATH hint" —
   not "v0.1.9: a beautiful new Slate experience". Commits describe
   change; they don't sell it.
7. **Don't rewrite the author's voice.** If a file already carries
   the author's phrasing — informal asides, opinionated framing, the
   `=>` arrow — leave it. That's the voice, not a draft. Even if a
   sentence breaks a rule above, err on the side of preserving it;
   the author's informal register is the thing these rules
   *protect*, not the thing they sand down. If you think a rewrite
   genuinely improves clarity, propose it in a comment or surface it
   in the response — don't ship the rewrite silently.

## Copy structure: why → how → what

Apply Simon Sinek's Golden Circle at both macro and micro levels.

- **Macro** (a README, a docs index page): lead with the motivation
  (*why*), then the approach (*how*), then the product details
  (*what*). The emotional hook goes first; the specs serve readers
  who are already in.
- **Micro** (a section, a toast, a tooltip): same order in
  miniature. A release-note bullet reads *"The agent's stream no
  longer freezes the chat input (why this matters) — the input now
  remains editable while a generate run is in flight (how) — fixed
  in `Whiteboard.tsx` (what)."* If a line is only "what," it's raw;
  add the why.

## Typography policy

Two fonts, strict rules.

### Handwritten (Excalifont) = personal voice

Reserve for places where a human is speaking directly to the reader.
People don't scan handwriting; they stop and read it, exactly once.
Use it sparingly so the stopping actually happens.

On the **docs site** (`docs/**`) — a Jekyll site we style ourselves,
so we can load the Excalifont woff2 file and apply it — use
Excalifont only for:
- The Slate wordmark.
- The tagline beneath it.
- Any "Built alongside Fathom" / origin-story section — the
  author's voice.

In the **app** (`app/renderer/**` and the embedded `<Whiteboard>`
component) use Excalifont for:
- The Slate wordmark on the welcome / paste-prompt screen.
- Tagline text.
- Any text rendered *inside* the Excalidraw canvas — those use
  Excalifont natively because that's the editor's font.
- Nowhere else in the chrome. Not in menus, not in button labels,
  not in the chat input, not in error text, not in the activity log.

On **GitHub README.md** — we can't. GitHub strips `style` and
`font-family` from inline HTML and won't load external fonts.
Don't reach for an image of the text either — it's unselectable,
unsearchable, and wastes bytes. The native-markdown pattern for a
"voice moment" in the README is a **blockquote**:

```markdown
## Built alongside Fathom

> I'm Ashrya, an AI scientist. While building Fathom — a
> research-paper reader with a per-paper whiteboard tab — it became
> clear that the whiteboard surface was useful on its own. So I
> extracted the same component into a standalone Mac app — and
> that's Slate.
```

The vertical-bar indent GitHub renders is the voice signal.
Combine with *italics* for emphasis where the prose wants it.
Handwriting + handwritten images go in the docs site and the app,
not the README.

### Sans (system) = information

Everything else. Navigation, body prose past the hero, section
headings, tables, code, buttons, labels, toasts, errors, release
notes, any scannable list. Information should scan; handwriting
gets in the way.

✗ If you catch yourself making "the whole docs page handwritten
because it's prettier", undo it. The handwriting stops being
special once everything is handwritten.

## Platform affordances

- **The terminal install is the PRIMARY CTA, everywhere.** Slate's
  build / ship / update workflow is terminal-first
  (`install.sh`, the `slate` launcher, `slate update`), and the
  external communication must reflect that. Any install surface —
  README, docs home hero, `INSTALL.md`, in-app about, release
  notes — leads with the `curl … | bash` chip, sized to announce
  itself. The DMG is always a *text link* underneath — e.g. "Prefer
  drag-to-Applications? Get the Mac DMG →" — that jumps to a
  Mac-install section containing the numbered steps plus the DMG
  download link inside those steps.
- **No Apple-glyph DMG button in the hero.** The Apple glyph on a
  big dark pill trains users to think of the GUI install as the
  "real" one; our workflow says the terminal is the real one. The
  download icon belongs inside the Mac-install section, attached
  to the download-step link.
- **Code / commands** stay in a monospace chip (SF Mono / Menlo).
  Selectable (`user-select: all`). Terminal commands are a proof
  of authenticity; treat them as evidence, not ornament. Hero-
  level install chips get a one-click copy button next to them.
- **Keyboard shortcuts** in body text use `<kbd>`: ⌘, ⌘V, ⌘
  Return, Esc, etc.

## Aesthetic direction

- Palette: warm light grey background (`#f5f5f7`), ink, amber
  accent. No cold colors. No gradients. No gloss. (The exact hex
  values live in `app/renderer/` styles; treat them as the source
  of truth, not this page.)
- Illustration: hand-drawn Excalidraw-style (rounded rects, soft
  strokes, warm beige fills). Never Mermaid, never ASCII, never
  stock icons. The agent draws in this style natively because the
  canvas IS Excalidraw — match the chrome to it.
- Animation: restrained. Easing, not bounces. Motion that confirms
  action, not motion that entertains.
- Whitespace over frames. Where a rule or border could clarify
  structure, try spacing first.

## Before you ship

Before calling a copy/visual change done, walk through:

1. Would a **busy researcher** (the target user) skim this and
   understand what Slate is in 10 seconds?
2. Is anything here persuasive where it should be descriptive?
3. Are the handwritten/sans choices aligned with the voice/info
   split above — or did handwriting creep into "information"
   territory?
4. Did the change touch any copy in a location that
   `slate-ux-review` would audit for accessibility, locale, or
   keyboard affordances? Run that skill too if so.

## Pitfalls to avoid

- **Making the handwritten font "feel more themed" by applying it
  everywhere.** That kills the effect. Pull it back.
- **Writing like a product-marketing blog post.** If a sentence
  would feel at home on a landing page for a Series-B startup,
  rewrite it.
- **Leaving in phrases like "powerful", "seamless", "beautifully
  designed".** Those are not descriptions; they are incantations.
- **Mixing voices.** If the welcome card talks like a founder and
  the update toast talks like a compiler, the user senses two
  people. Match.
- **Treating Slate as Fathom-derived in the public copy.** The
  README's "Built alongside Fathom" section names the lineage
  honestly, but Slate's value prop stands on its own — paste-driven
  brainstorming. Don't write Slate as "the whiteboard tab without
  the PDF reader." Write it as what it is.
