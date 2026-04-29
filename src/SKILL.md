---
name: excalidraw-diagram
description: Principles for diagrams that argue visually. Apply to whatever subject the host gives you.
---

# Diagrams that argue, not diagrams that display

A diagram is a visual argument. Its shape carries meaning that words can't. Your job is to let the *content* drive the form — never the other way around. Don't reach for a template; reach for whatever structure makes this particular subject's claim visible.

## Core principles

- **The Isomorphism Test.** If you removed all text, would the structure alone communicate the concept? If not, redesign. Two parallel things should look parallel; a hub-and-spoke relationship should look like a hub; a feedback loop should close on itself; a transformation should show before and after.
- **The Education Test.** Could a curious reader learn something *concrete* from this diagram, or does it just label boxes? Aim for "I now understand a thing I didn't before," not "here are five labeled rectangles."
- **Use real names.** Whatever subject you're given, use its actual vocabulary — real component names, real symbols, real terms. Generic placeholders like "Encoder", "Module A", "Process" are almost always wrong.
- **Variety follows from the subject.** When a diagram has multiple major concepts, each one's visual treatment should reflect *its* nature, not a slot in a template. If two concepts look identical and they aren't identical, that's a missed opportunity. If two concepts look different and they should look the same, that's noise.
- **Pick whatever shape arrangement fits the subject.** The subject decides whether the diagram is a flow, a tree, a cycle, a comparison, a layered stack, a single hero with annotations, or none of the above. Don't impose a structure the subject doesn't want.

## What to avoid (anti-patterns)

| Don't | Why |
|-------|-----|
| Five equal boxes in a grid | A grid implies "five comparable items" — usually false, almost never the most important relationship |
| Card-style layouts (every concept = same-sized rectangle) | Forces uniformity onto things that aren't uniform |
| Containers around every piece of text | A label doesn't need a box. Boxes mean something — overuse dilutes the signal |
| Decorative icons next to every label | Decoration competes with meaning |
| Everything the same color | Color should encode information, not mood |

## Render correctness (the create_view contract)

When you call `create_view`, the elements JSON has a few non-negotiable rules so the canvas renders:

- The `text` property of a text element contains *only* the readable words — no JSON, no element ids embedded, just the string the reader sees.
- Standard text settings: `fontSize: 16`, `fontFamily: 3`, `textAlign: "center"`, `verticalAlign: "middle"`. Larger sizes for titles/heroes; never below 12.
- `roughness: 0` for clean lines (default); `roughness: 1` only if you're explicitly going for a sketched feel.
- `opacity: 100` for every element. Use color, size, and stroke width for hierarchy — not transparency.
- Every element needs a unique `id`. If you delete an element by id and re-add at the same position, give the replacement a new id.
- For arrows that connect two shapes, set `boundElements` on both sides so the connection survives layout.

## Iterate by looking

After each `create_view` call, look at what came back. Ask:

1. Does the structure pass the Isomorphism Test? (If text were gone, would the shape still tell the story?)
2. Did anything end up wrong — overlapping elements, clipped text, an arrow ending in empty space, a region with too much whitespace next to a region that's cramped?
3. Did the most important idea become the visual focus, or did something secondary dominate?

If the answer to any of these is "no," call `create_view` again with `restoreCheckpoint` to extend or `delete` to remove and replace. Two or three iterations is normal; one iteration is rare unless the subject is very simple.

## On the JSON wrapper

Your final scene is a single Excalidraw document:

```json
{
  "type": "excalidraw",
  "version": 2,
  "elements": [...],
  "appState": { "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

The `elements` array is what you author through `create_view`. The host handles persistence; you don't need to think about saving.
