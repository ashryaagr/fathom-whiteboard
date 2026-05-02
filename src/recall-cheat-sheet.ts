// Excalidraw element-format reference inlined as a system-prompt
// fragment, so the agent doesn't have to spend a tool turn calling
// `mcp__excalidraw__read_me` before its first `create_view`.
//
// Source of truth: vendor/excalidraw-mcp/src/server.ts → RECALL_CHEAT_SHEET.
// Keep this file in sync when the vendored MCP server is updated.
// (The MCP's read_me tool still exists and returns the same content,
// so older clients that call it still work — but our pipeline no
// longer needs the round-trip.)
export const EXCALIDRAW_CHEAT_SHEET = `# Excalidraw Element Format

## Color Palette (use consistently across all tools)

### Primary Colors
| Name | Hex | Use |
|------|-----|-----|
| Blue | \`#4a9eed\` | Primary actions, links, data series 1 |
| Amber | \`#f59e0b\` | Warnings, highlights, data series 2 |
| Green | \`#22c55e\` | Success, positive, data series 3 |
| Red | \`#ef4444\` | Errors, negative, data series 4 |
| Purple | \`#8b5cf6\` | Accents, special items, data series 5 |
| Pink | \`#ec4899\` | Decorative, data series 6 |
| Cyan | \`#06b6d4\` | Info, secondary, data series 7 |
| Lime | \`#84cc16\` | Extra, data series 8 |

### Excalidraw Fills (pastel, for shape backgrounds)
| Color | Hex | Good For |
|-------|-----|----------|
| Light Blue | \`#a5d8ff\` | Input, sources, primary nodes |
| Light Green | \`#b2f2bb\` | Success, output, completed |
| Light Orange | \`#ffd8a8\` | Warning, pending, external |
| Light Purple | \`#d0bfff\` | Processing, middleware, special |
| Light Red | \`#ffc9c9\` | Error, critical, alerts |
| Light Yellow | \`#fff3bf\` | Notes, decisions, planning |
| Light Teal | \`#c3fae8\` | Storage, data, memory |
| Light Pink | \`#eebefa\` | Analytics, metrics |

### Background Zones (use with opacity: 30 for layered diagrams)
| Color | Hex | Good For |
|-------|-----|----------|
| Blue zone | \`#dbe4ff\` | UI / frontend layer |
| Purple zone | \`#e5dbff\` | Logic / agent layer |
| Green zone | \`#d3f9d8\` | Data / tool layer |

---

## Excalidraw Elements

### Required Fields (all elements)
\`type\`, \`id\` (unique string), \`x\`, \`y\`, \`width\`, \`height\`

### Defaults (skip these)
strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=1, opacity=100
Canvas background is white.

### Element Types

**Rectangle**: \`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }\`
- \`roundness: { type: 3 }\` for rounded corners
- \`backgroundColor: "#a5d8ff"\`, \`fillStyle: "solid"\` for filled

**Ellipse**: \`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Diamond**: \`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Labeled shape (PREFERRED)**: Add \`label\` to any shape for auto-centered text. No separate text element needed.
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "Hello", "fontSize": 20 } }\`
- Works on rectangle, ellipse, diamond
- Text auto-centers and container auto-resizes to fit
- Saves tokens vs separate text elements

**Labeled arrow**: \`"label": { "text": "connects" }\` on an arrow element.

**Standalone text** (titles, annotations only):
\`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "Hello", "fontSize": 20 }\`
- x is the LEFT edge of the text. To center text at position cx: set x = cx - estimatedWidth/2
- estimatedWidth ≈ text.length × fontSize × 0.5
- Do NOT rely on textAlign or width for positioning — they only affect multi-line wrapping

**Arrow**: \`{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "arrow" }\`
- points: [dx, dy] offsets from element x,y
- endArrowhead: null | "arrow" | "bar" | "dot" | "triangle"

### Arrow Bindings
Arrow: \`"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }\`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]

**cameraUpdate** (pseudo-element — controls the viewport, not drawn):
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`
- x, y: top-left corner of the visible area (scene coordinates)
- width, height: size of the visible area — MUST be 4:3 ratio (400×300, 600×450, 800×600, 1200×900, 1600×1200)
- Animates smoothly between positions — use multiple cameraUpdates to guide attention as you draw
- No \`id\` needed — this is not a drawn element

**delete** (pseudo-element — removes elements by id):
\`{ "type": "delete", "ids": "b2,a1,t3" }\`
- Comma-separated list of element ids to remove
- Also removes bound text elements (matching \`containerId\`)
- Place AFTER the elements you want to remove
- Never reuse a deleted id — always assign new ids to replacements

### Drawing Order (CRITICAL for streaming)
- Array order = z-order (first = back, last = front)
- **Emit progressively**: background → shape → its label → its arrows → next shape
- BAD: all rectangles → all texts → all arrows
- GOOD: bg_shape → shape1 → text1 → arrow1 → shape2 → text2 → ...

### Camera & Sizing (CRITICAL for readability)

The diagram displays inline at ~700px width. Design for this constraint.

**Recommended camera sizes (4:3 aspect ratio ONLY):**
- Camera **S**: width 400, height 300 — close-up on a small group (2-3 elements)
- Camera **M**: width 600, height 450 — medium view, a section of a diagram
- Camera **L**: width 800, height 600 — standard full diagram (DEFAULT)
- Camera **XL**: width 1200, height 900 — large diagram overview. WARNING: font size smaller than 18 is unreadable
- Camera **XXL**: width 1600, height 1200 — panorama / final overview of complex diagrams. WARNING: minimum readable font size is 21

ALWAYS use one of these exact sizes. Non-4:3 viewports cause distortion.

**Font size rules:**
- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles and headings
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14 — it becomes unreadable at display scale

**Element sizing rules:**
- Minimum shape size: 120×60 for labeled rectangles/ellipses
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

ALWAYS start with a \`cameraUpdate\` as the FIRST element. For example:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`

- x, y: top-left corner of visible area (scene coordinates)
- ALWAYS emit the cameraUpdate BEFORE drawing the elements it frames — camera moves first, then content appears
- The camera animates smoothly between positions
- Leave padding: don't match camera size to content size exactly (e.g., 500px content in 800x600 camera)

Examples:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\` — standard view
\`{ "type": "cameraUpdate", "width": 400, "height": 300, "x": 200, "y": 100 }\` — zoom into a detail
\`{ "type": "cameraUpdate", "width": 1600, "height": 1200, "x": -50, "y": -50 }\` — panorama overview

Tip: For large diagrams, emit a cameraUpdate to focus on each section as you draw it.

## Checkpoints (restoring previous state)

Every create_view call returns a \`checkpointId\` in its response. To continue from a previous diagram state, start your elements array with a restoreCheckpoint element:

\`[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...additional new elements...]\`

The saved state (including any user edits made in fullscreen) is loaded from the client, and your new elements are appended on top. This saves tokens — you don't need to re-send the entire diagram.

## Deleting Elements

Remove elements by id using the \`delete\` pseudo-element:

\`{"type":"delete","ids":"b2,a1,t3"}\`

Works in two modes:
- **With restoreCheckpoint**: restore a saved state, then surgically remove specific elements before adding new ones
- **Inline (animation mode)**: draw elements, then delete and replace them later in the same array to create transformation effects

Place delete entries AFTER the elements you want to remove. The final render filters them out.

**IMPORTANT**: Every element id must be unique. Never reuse an id after deleting it — always assign a new id to replacement elements.

## Animation Mode — Transform in Place

You can animate by DELETING elements and replacing them at the same position. Combined with slight camera moves, this creates smooth visual transformations during streaming.

Pattern:
1. Draw initial elements
2. cameraUpdate (shift/zoom slightly)
3. \`{"type":"delete","ids":"old1,old2"}\`
4. Draw replacements at same coordinates (different color/content)
5. Repeat

## Dark Mode

If the user asks for a dark theme/mode diagram, use a massive dark background rectangle as the FIRST element (before cameraUpdate). Make it 10x the camera size so it covers the entire viewport even when panning:

\`{"type":"rectangle","id":"darkbg","x":-4000,"y":-3000,"width":10000,"height":7500,"backgroundColor":"#1e1e2e","fillStyle":"solid","strokeColor":"transparent","strokeWidth":0}\`

Then use these colors on the dark background:

**Text colors (on dark):**
| Color | Hex | Use |
|-------|-----|-----|
| White | \`#e5e5e5\` | Primary text, titles |
| Muted | \`#a0a0a0\` | Secondary text, annotations |
| NEVER | \`#555\` or darker | Invisible on dark bg! |

**Shape fills (on dark):**
| Color | Hex | Good For |
|-------|-----|----------|
| Dark Blue | \`#1e3a5f\` | Primary nodes |
| Dark Green | \`#1a4d2e\` | Success, output |
| Dark Purple | \`#2d1b69\` | Processing, special |
| Dark Orange | \`#5c3d1a\` | Warning, pending |
| Dark Red | \`#5c1a1a\` | Error, critical |
| Dark Teal | \`#1a4d4d\` | Storage, data |

**Stroke/arrow colors (on dark):**
Use the Primary Colors from above — they're bright enough on dark backgrounds. For shape borders, use slightly lighter variants or \`#555555\` for subtle outlines.

## Tips
- Use the color palette consistently
- **Text contrast is CRITICAL** — never use light gray (#b0b0b0, #999) on white backgrounds. Minimum text color on white: #757575. For colored text on light fills, use dark variants (#15803d not #22c55e, #2563eb not #4a9eed). White text needs dark backgrounds (#9a5030 not #c4795b)
- Do NOT use emoji in text — they don't render in Excalidraw's font
- cameraUpdate is MAGICAL and users love it! please use it a lot to guide the user's attention as you draw.
`;
