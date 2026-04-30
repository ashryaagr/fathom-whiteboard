---
name: slate-ux-review
description: Review Slate control / paste-flow / install / update changes against macOS conventions and Apple HIG. Run this BEFORE committing any diff that touches the paste prompt, refinement chat, canvas keyboard shortcuts, or the install/update flow.
type: skill
---

# Slate UX design-pattern review

Slate aims for an Apple-level feel. Every control earns that by
matching intuitive patterns the user already knows from other Mac apps,
Safari, and the macOS system itself. **A control is worse than not
having it at all if it misleads the user about what it does.**

This skill is the checklist an agent runs over a proposed UX change
before committing.

## When to use this skill

Invoke this skill **automatically** (without the user asking) whenever a
diff touches:

- `app/main.ts` (window setup, IPC, file-system surfaces)
- `app/preload.ts` (the `window.wb` API surface the renderer uses)
- `app/renderer/**` (the paste prompt, the chat input, the activity
  log, the welcome card)
- `src/Whiteboard.tsx` (the canvas component, the chat input behavior,
  abort affordance, edit-while-streaming behavior)
- `src/react.ts` (exported React surface for embedded hosts)
- `install.sh` (install UX copy, terminal prompts)
- `electron-builder.config.cjs` (DMG layout, icon)

## The checklist

### 1. Keyboard convention is intuitive on Mac

- `⌘ V` = Paste. Every paste surface in Slate handles `paste` events
  natively — text, image, file. Don't override this.
- `⌘ Return` (or just `Return` in a single-line input) = Submit. The
  chat input in `<Whiteboard>` should accept Return as send and
  Shift+Return as newline (multi-line refinement asks).
- `Esc` = Abort the current generate/refine run if one is in flight.
  Same Esc on a free canvas closes the chat overlay (if any).
- `⌘ ,` = Preferences (when Slate has any). Not Settings (App Store
  naming), not in Help.

### 1a. React selector / state convention

Recurring class of bug across React state libraries: shipped a
"Maximum update depth exceeded" infinite-loop because a selector
returned a freshly-allocated value every render. Same rule applies
in Slate even though the surface is smaller:

```ts
// ❌ WRONG — `?? []` allocates a new array each render
const elements = useStore((s) => s.scene?.elements ?? []);
// ❌ WRONG — `.filter(...)` returns a new array each render
const visible = useStore((s) => s.elements.filter(fn));
// ❌ WRONG — object literal each render
const ui = useStore((s) => ({ open: s.open, focused: s.focused }));
```

Default reference-equality means each call → re-subscribe →
re-render → re-allocate → infinite loop.

```ts
// ✓ RIGHT — select primitives, derive in useMemo
const sceneRef = useStore((s) => s.scene);
const elements = useMemo(
  () => sceneRef?.elements ?? EMPTY_ARRAY,
  [sceneRef],
);
// ✓ RIGHT — multiple primitive selectors
const open = useStore((s) => s.open);
const focused = useStore((s) => s.focused);
```

This rule belongs in the agent harness. Future PRs should grep
their diff for `?? []` / `?? new Map()` / `?? {}` inside any
selector hook and reject.

### 2. A control doesn't fire if it has nothing to do

Every control must check that its action has an effect before
committing visual feedback:

- Submit a refinement → only if scene is non-empty AND chat input
  is non-empty.
- Abort → only if a generate/refine run is active.
- Restart-from-scratch (regenerate) → confirm if the user has made
  manual canvas edits (those would be lost).

If the action would be a no-op, **let the underlying default
happen**. Don't preventDefault. Don't show an animation.

### 3. Platform conventions hold

- `⌘ O` = Open. (Slate has nothing to open in the standalone v0.1.x;
  reserve the shortcut.)
- `⌘ ,` = Preferences.
- `⌘ Q` = Quit.
- `⌘ N` = New session (clears the canvas + paper after confirmation).
- `Esc` — if it doesn't do what users expect (abort the in-flight
  run), show them what does via a hint.

### 4. Affordance is visible before the action

The paste prompt, the chat input, and the regenerate button need
to be visible *before* the user tries to use them. "The feature
exists but users can't find it" is a design failure, not a user
failure.

- Welcome screen has a visible paste prompt with placeholder
  text ("Paste anything…") and a Return-to-submit affordance.
- Chat input has a visible send button (or a clear placeholder
  that names the Return key).
- Activity log expanding behavior is discoverable — collapsed
  by default with an obvious chevron, not hidden behind a
  modifier key.

### 5. First-time install: zero friction, zero prior knowledge

- DMG path: user drags to Applications, right-click → Open. Not
  more.
- Terminal path: `curl … | bash`. One command, complete in <15s.
- No README-finding required. The DMG background tells you how to
  install. The install.sh tells you what it did.
- If `~/.local/bin` isn't on PATH, the script prints the exact
  line to add — not a link to documentation.

### 6. Updates: zero re-installation ritual

- No re-drag-to-Applications on update.
- No re-approve in Privacy & Security.
- `slate update` is the only command the user needs to remember.
- The user runs it, the app vanishes for ~5 seconds, the new
  version comes back.

### 7. Copy is plain English

- Empty state says "Paste anything to begin", not "Awaiting input".
- Error says "Couldn't reach Claude — check your internet", not
  "AbortError at agent.ts:42 code ECONNREFUSED".
- Buttons are verbs: "Generate", "Abort", "Refine", "Regenerate
  from scratch", not "OK" / "Confirm" / "Proceed".

### 8. Visual feedback is one-to-one with action

- Action succeeds → feedback shows.
- Action doesn't happen → no feedback. (See rule 2.)
- Action is slow → progress indicator while it waits. The activity
  log streaming is the canonical example: as soon as the user hits
  Return, the log shows `[tool_use] mcp__excalidraw__read_me`,
  proving the agent is alive.
- Action fails → failure state shows the remedy, not the error
  code.

### 9. Reading (not writing) changes nothing

Hovering over a canvas element, opening the activity-log panel,
reading the chat history — none of these should mutate state or
fire any user-visible side effect. Only explicit actions (paste,
submit, abort, edit-on-canvas) are allowed to move the app to a
new state.

### 10. Embed-host parity

The `<Whiteboard>` React component is published as
`fathom-whiteboard` on npm and embedded inside Fathom (and
potentially future hosts). Every UX change in the Slate Electron
shell that touches the component must:

- Work identically inside an embedded host. The component
  must not assume an Electron-specific API (use the
  `WhiteboardHost` interface in `src/Whiteboard.tsx`).
- Add new host-methods only via the existing `WhiteboardHost`
  contract — don't reach into Electron globals from inside the
  React surface.
- Be testable without launching the standalone Slate app — the
  npm package consumer should be able to run a local mount.

### 11. Principle gate — placeholder UI must be marked SHIP-BLOCKING

Any UI that is acknowledged as a placeholder for a stated
CLAUDE.md principle is SHIP-BLOCKING until either (a) the
principle is satisfied, or (b) the principle is explicitly
revised by the user. Phrases like "for now we show a static
placeholder; will replace with X later" in code comments are a
*self-confessed* violation of a principle. Such code may not
coexist with new feature work — finish the principle first.

`todo.md` `🔄 PENDING` entries that describe a fix to a principle
violation (not a new feature) take priority over any other
scheduled item, and the next release MUST advance them.

### 12. No-frozen-UI rule

Established in Slate from day one (CLAUDE.md §2). While the agent
is drawing, the chat input stays editable; the user can type the
next refinement, paste an image, or abort the run. A frozen input
during a 60-second agent turn is a fatigue source we don't
accept. Any UX change that introduces a frozen-during-stream
behavior is a regression — reject the diff.

## How to run this review

1. Read the diff.
2. Walk every item in the checklist against the changed files.
3. For each item, write "✓" if the change respects it, "⚠" with a
   note if ambiguous, "✗" with the exact issue if violated.
4. Before committing, all ✗ issues must be resolved (or the
   commit is an explicit deviation with the user's approval
   captured in the commit message).
5. Log the review result in the commit body so future agents can
   retrace the reasoning.

## Pitfalls to avoid

- **"The test passes" ≠ the UX is right.** Tests verify code
  paths; this review verifies mental-model alignment.
- **"I tested it on my machine" ≠ "users will find it."**
  Discoverability failures are silent — nobody reports a feature
  they couldn't see.
- **"It's consistent with our own prior version" ≠ "it's
  intuitive."** If an earlier version of Slate violated a macOS
  convention, the fix is to align, not to compound.
