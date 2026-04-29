/**
 * Whiteboard runtime AC validation — spec-version-agnostic core.
 *
 * The user has named two bugs they will not tolerate:
 *   1. Text that escapes its containing box.
 *   2. Boxes that overlap other boxes.
 *
 * These predicates fire on any whiteboard scene regardless of the
 * outer spec shape (v2 L1+L2+chat lanes, v3 multi-section narrative,
 * future variants). They check structural invariants that hold across
 * paradigms.
 *
 * Spec-shape-specific assertions (lane outlines, model-node count,
 * chat-band placement, cross-zone edge style, ...) live elsewhere and
 * compose with this module via the same `ACReport` shape — that way
 * the WhiteboardTab mount effects can call one validator and merge
 * the result.
 *
 * `validateScene` returns `{fails, warns}`. Caller (the WhiteboardTab
 * mount effects) decides what to do:
 *   - dev build: FAIL → console.error + abort + visible toast.
 *   - prod build: FAIL → console.warn + dump (don't break the user's flow).
 *
 * What this file is NOT:
 *   - Not a layout engine. Checks invariants on an already-laid-out
 *     scene; doesn't move anything.
 *   - Not a schema validator. Assumes elements have valid Excalidraw
 *     shape; just checks our own semantic invariants.
 */

// ----------------------------------------------------------------------
// Element shape — minimal subset of Excalidraw's element type. We type
// only the fields the AC predicates actually read; widening the type
// would couple this file to Excalidraw's internal type churn.
// ----------------------------------------------------------------------

/** Tag set the renderer + agents stamp on `customData.fathomKind`.
 * Some are v2-shape-specific (wb-lane-outline, wb-frame); kept in the
 * union for compatibility with stashed v2 work — the v2/v3 shared
 * predicates below DO NOT depend on these enum values, only on the
 * structural fact "this is a node/edge/zone/free text." */
export type FathomKind =
  | 'wb-node'
  | 'wb-citation'
  | 'wb-drill-glyph'
  | 'wb-frame'
  | 'wb-edge'
  | 'wb-title'
  | 'wb-summary'
  | 'wb-figure'
  | 'wb-skeleton'
  | 'wb-chat-frame'
  | 'wb-zone'
  | 'wb-zone-label'
  | 'wb-camera'
  | 'wb-lane-outline'
  | 'wb-section'
  | 'wb-callout'
  | 'wb-callout-tag'
  | 'wb-callout-body'
  | 'wb-annotation';

interface ACBoundElement {
  id: string;
  type: 'text' | 'arrow';
}

export interface ACElement {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  /** Excalidraw font family code: 1=Virgil/handdrawn, 2=Helvetica, 3=Cascadia (mono),
   *  5=Excalifont. AC-MATH-NO-CONTAINER uses fontFamily===3 to identify
   *  monospace text that the agent intends as math/code. */
  fontFamily?: number;
  containerId?: string | null;
  boundElements?: ACBoundElement[] | null;
  label?: { text?: string; fontSize?: number } | null;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  opacity?: number;
  points?: Array<[number, number]>;
  customData?: {
    fathomKind?: FathomKind;
    nodeId?: string;
    parentId?: string;
    level?: number;
    drillable?: boolean;
    kind?: string;
    isChat?: boolean;
    chatQueryId?: string;
    /** v2-era lane fields. Stashed branch uses these; v3 may rename. */
    laneIndex?: number;
    laneXMin?: number;
    laneXMax?: number;
    /** v2-era partial-frame flag. */
    isPartial?: boolean;
  };
}

// ----------------------------------------------------------------------
// Result types.
// ----------------------------------------------------------------------

export type ACSeverity = 'FAIL' | 'WARN';

export interface ACViolation {
  /** Stable identifier — e.g. `AC-OVERLAP`, `AC-TEXT-FIT`. Used in
   * the toast + log line + downstream filtering. */
  id: string;
  severity: ACSeverity;
  /** Human-readable description (rendered in the toast and the log). */
  message: string;
  /** Element ids implicated, when applicable. Helps the dev jump to
   * the offending shape in DevTools. */
  elementIds?: string[];
}

export interface ACReport {
  fails: ACViolation[];
  warns: ACViolation[];
}

// ----------------------------------------------------------------------
// Geometry primitives — kept tiny so the AC predicates stay readable.
// All coordinates are in scene coords (Excalidraw's canvas space).
// ----------------------------------------------------------------------

export interface BBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export function bboxOf(el: ACElement): BBox | null {
  if (typeof el.x !== 'number' || typeof el.y !== 'number') return null;
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  return { xMin: el.x, yMin: el.y, xMax: el.x + w, yMax: el.y + h };
}

export function boxesOverlap(a: BBox, b: BBox, tol = 0): boolean {
  // Strict overlap: shared border doesn't count. Tolerance lets us
  // ignore sub-pixel grazing.
  return (
    a.xMin < b.xMax - tol &&
    a.xMax - tol > b.xMin &&
    a.yMin < b.yMax - tol &&
    a.yMax - tol > b.yMin
  );
}

/** Is bbox `inner` fully inside bbox `outer` (with optional pad)?
 * Used by AC-TEXT-FIT to check that a bound text element's rendered
 * bbox sits inside its container's bbox. `pad` lets the caller
 * tolerate Excalidraw's internal text padding (BOUND_TEXT_PADDING).
 */
export function bboxContains(outer: BBox, inner: BBox, pad = 0): boolean {
  return (
    inner.xMin >= outer.xMin - pad &&
    inner.yMin >= outer.yMin - pad &&
    inner.xMax <= outer.xMax + pad &&
    inner.yMax <= outer.yMax + pad
  );
}

/** Cohen–Sutherland: does the line segment (p0→p1) cross box `b`?
 * Returns true even when the segment grazes a corner. */
export function segmentCrossesBox(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  b: BBox,
): boolean {
  const code = (p: { x: number; y: number }): number => {
    let c = 0;
    if (p.x < b.xMin) c |= 1;
    else if (p.x > b.xMax) c |= 2;
    if (p.y < b.yMin) c |= 4;
    else if (p.y > b.yMax) c |= 8;
    return c;
  };
  let c0 = code(p0);
  let c1 = code(p1);
  let q0 = p0;
  let q1 = p1;
  for (let safety = 0; safety < 8; safety += 1) {
    if ((c0 | c1) === 0) return true;
    if ((c0 & c1) !== 0) return false;
    const cOut = c0 !== 0 ? c0 : c1;
    let x = 0;
    let y = 0;
    if (cOut & 8) {
      x = q0.x + ((q1.x - q0.x) * (b.yMax - q0.y)) / (q1.y - q0.y);
      y = b.yMax;
    } else if (cOut & 4) {
      x = q0.x + ((q1.x - q0.x) * (b.yMin - q0.y)) / (q1.y - q0.y);
      y = b.yMin;
    } else if (cOut & 2) {
      y = q0.y + ((q1.y - q0.y) * (b.xMax - q0.x)) / (q1.x - q0.x);
      x = b.xMax;
    } else {
      y = q0.y + ((q1.y - q0.y) * (b.xMin - q0.x)) / (q1.x - q0.x);
      x = b.xMin;
    }
    if (cOut === c0) {
      q0 = { x, y };
      c0 = code(q0);
    } else {
      q1 = { x, y };
      c1 = code(q1);
    }
  }
  return false;
}

/** Resolve an arrow element to its world-space polyline. Excalidraw
 * arrows store `x`/`y` as the first point and `points[]` as offsets
 * relative to that origin, so the world-space coords are
 * `{x: x + dx, y: y + dy}` per point. */
export function arrowPolyline(arrow: ACElement): Array<{ x: number; y: number }> {
  if (typeof arrow.x !== 'number' || typeof arrow.y !== 'number') return [];
  if (!Array.isArray(arrow.points) || arrow.points.length === 0) return [];
  return arrow.points.map(([dx, dy]) => ({ x: (arrow.x ?? 0) + dx, y: (arrow.y ?? 0) + dy }));
}

function pointDistanceToBox(p: { x: number; y: number }, b: BBox): number {
  const dx = Math.max(b.xMin - p.x, 0, p.x - b.xMax);
  const dy = Math.max(b.yMin - p.y, 0, p.y - b.yMax);
  return Math.sqrt(dx * dx + dy * dy);
}

// ----------------------------------------------------------------------
// What counts as a "content box"?
//
// The two structural bugs (overlap + text-overflow) only matter on
// content shapes — opaque rectangles, ellipses, diamonds the agent
// authored as boxes. They explicitly do NOT include:
//   - Background zones (semi-transparent grouping rects, deliberately
//     overlap content per Common Region principle).
//   - Lane outlines / section frames (deliberately frame other content).
//   - Citation chips (sub-element decorations, micro-frame at corner).
//   - Drill glyphs (sub-element affordances).
//   - Cameras (pseudo-elements stripped before render).
//   - Skeletons (placeholder shapes during Doherty ack).
// ----------------------------------------------------------------------

const NON_CONTENT_KINDS: Set<string> = new Set([
  'wb-zone',
  'wb-frame',
  'wb-lane-outline',
  'wb-section',
  'wb-citation',
  'wb-drill-glyph',
  'wb-camera',
  'wb-skeleton',
  'wb-title',
  'wb-figure',
]);

function isContentShape(el: ACElement): boolean {
  if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'diamond') return false;
  const fk = el.customData?.fathomKind;
  if (!fk) return false;
  // Treat anything we don't recognise as non-content (free user-drawn
  // shapes are out of our scope; we only assert on agent-authored
  // content the wb-* tag identifies).
  return !NON_CONTENT_KINDS.has(fk);
}

/** True when this element is a free-floating text (not bound to a
 * container via containerId). Free text drawn over a content shape is
 * the "annotation sitting on top of a box" bug class. */
function isFreeText(el: ACElement): boolean {
  if (el.type !== 'text') return false;
  if (typeof el.containerId === 'string' && el.containerId.length > 0) return false;
  return true;
}

// ----------------------------------------------------------------------
// validateScene — the public entry point.
//
// Six predicates, all spec-version-agnostic:
//   AC-OVERLAP          (FAIL): no two content boxes overlap.
//   AC-TEXT-FIT         (FAIL): no bound text exceeds its container's bbox.
//   AC-FREE-TEXT-CLEAR  (WARN): no free-floating text overlaps a content shape.
//   AC-EDGE-NO-CROSS    (FAIL): no edge polyline crosses a non-endpoint shape.
//   AC-DOUBLE-BIND      (FAIL): no shape has both `label:` AND a containerId-text.
//   AC-NO-PSEUDO        (FAIL): no `wb-camera` survives the strip pass.
// ----------------------------------------------------------------------

/** Optional input-doc hints for ACs that need to know whether the
 * SOURCE paper has math / thesis signals. AC-MULTI-SECTION uses this:
 * if the paper has equations, the agent shouldn't be authoring a
 * single-section workflow render. The runPass2 caller passes the hint
 * by inspecting the Pass 1 understanding doc. */
export interface ACHints {
  /** True if the input understanding doc mentions equations, theorems,
   * or formulas the agent should be visualising as a math callout. */
  hasMathSignal?: boolean;
  /** True if the input understanding doc names a thesis / takeaway /
   * key insight worth promoting to a KEY IDEA callout. */
  hasThesisSignal?: boolean;
}

export function validateScene(
  elements: readonly ACElement[],
  hints?: ACHints,
): ACReport {
  const fails: ACViolation[] = [];
  const warns: ACViolation[] = [];
  const push = (v: ACViolation): void => {
    if (v.severity === 'FAIL') fails.push(v);
    else warns.push(v);
  };

  acOverlap(elements).forEach(push);
  acTextFit(elements).forEach(push);
  acFreeTextClear(elements).forEach(push);
  acEdgeNoCross(elements).forEach(push);
  acDoubleBind(elements).forEach(push);
  acNoSurvivingPseudo(elements).forEach(push);
  // v3.2.1 — critic-rubric ACs (rules 1-3, 4, 6).
  acMultiSection(elements, hints).forEach(push);
  acZonePerSection(elements).forEach(push);
  acRoleColorMatch(elements).forEach(push);
  // v3.2.1 phase B — three more critic-rubric ACs:
  acCameraPresent(elements).forEach(push);   // rule 3 — camera-as-narration
  acMathNoContainer(elements).forEach(push); // rule 6 — math is text, not box
  acProgressiveEmit(elements).forEach(push); // rule 4 — array order = streaming order
  // v3.2.1 phase D critic round 1 — text fidelity at load-bearing labels.
  acTextNoTruncation(elements).forEach(push); // rule 1 — zone titles + section headers cannot truncate
  // v3.2.1 phase D critic round 3 — paragraph overflow + sequential section numbers.
  acParagraphWidthFit(elements).forEach(push);    // round 3 ask 1 — paragraph text must fit section width
  acSectionNumberSequential(elements).forEach(push); // round 3 ask 2 — section numbers 1, 2, 3, no gaps
  // v3.2.1 phase D critic round 4 — overlapping free-text detection.
  acTextNoCollision(elements).forEach(push);      // round 4 ask 1 — no two free-text elements may share >10% bbox area
  // v3.2.1 phase D critic round 5 — color-role consistency within a zone.
  acColorRoleConsistency(elements).forEach(push); // round 5 ask 2 — at most one green node per zone (terminal only)
  // v3.2.1 phase D user round 7 — callout body must fit its callout box.
  acCalloutBodyFit(elements).forEach(push);       // round 7 user ask — text must not escape callout
  // v3.2.1 phase D critic round 8 — generalize round-7 fit-check to ALL container/text pairs.
  acContainerTextFit(elements).forEach(push);     // round 8 critic ask 3 — coverage extends to zone-label, node-question, etc.
  // v3.2.1 phase D user round 8 — every architecture node must carry a "→ question" subtitle.
  acComponentHasQuestion(elements).forEach(push); // round 8 user ask — components-as-question-answers

  return { fails, warns };
}

// ----------------------------------------------------------------------
// AC-OVERLAP (FAIL) — the user's #1 named bug. No two content shapes
// share interior pixels. Tolerance of 0.5 px to avoid sub-pixel false
// positives from animated repositioning.
// ----------------------------------------------------------------------

function acOverlap(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const content: Array<{ id: string; bb: BBox }> = [];
  for (const el of elements) {
    if (!isContentShape(el)) continue;
    if (!el.id) continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    content.push({ id: el.id, bb });
  }
  for (let i = 0; i < content.length; i += 1) {
    for (let j = i + 1; j < content.length; j += 1) {
      if (boxesOverlap(content[i].bb, content[j].bb, 0.5)) {
        out.push({
          id: 'AC-OVERLAP',
          severity: 'FAIL',
          message: `Content shapes ${content[i].id} and ${content[j].id} overlap. The renderer must not surface scenes where two declared boxes share pixels.`,
          elementIds: [content[i].id, content[j].id],
        });
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-TEXT-FIT (FAIL) — the user's #2 named bug. Two complementary
// modes:
//
//   (A) Post-conversion mode. After `convertToExcalidrawElements`
//       runs, the `label:` sugar has materialised as a separate text
//       element with `containerId` set back to the rect. We check
//       that text bbox sits inside the container bbox with
//       BOUND_TEXT_PADDING (5px) slack on every side.
//
//   (B) Pre-conversion mode. Before conversion, the `label.text` is
//       still inline on the rectangle. We can't measure rendered
//       width without a Canvas 2D context, but we CAN estimate it
//       conservatively from char-count × per-char width at the label
//       fontSize, accounting for line breaks (`\n`). If the longest
//       line's estimated width > rect.width - 2*pad, OR the line
//       count's stacked height > rect.height - 2*pad, fire.
//
// The two modes overlap intentionally: (A) catches actual rendered
// overflow (truth on the canvas); (B) catches it earlier, before the
// renderer ever sees the scene, so the agent can self-correct via
// look_at_scene + an MCP error.
//
// (B)'s char-width estimates are calibrated to Excalifont (the live
// app font) at 16px → ~10 px/char, 13px → ~7.5 px/char (matches the
// MCP wrapper's LABEL_CHAR_W / SUMMARY_CHAR_W constants from the
// existing whiteboard-mcp.ts code). Conservative — Excalifont's
// proportional widths run narrower than this for most letters; a
// false positive is preferable to a false negative because the
// failure mode of letting clipped text ship is the user's #2 bug.
// ----------------------------------------------------------------------

const BOUND_TEXT_PADDING = 5;
/** Per-character width estimate at a given fontSize, calibrated to
 * Excalifont (matches the MCP wrapper's LABEL_CHAR_W=10 @ 16px and
 * SUMMARY_CHAR_W=7.5 @ 13px). Slope ≈ 0.625 px-of-char per px-of-font. */
function estCharWidth(fontSize: number): number {
  return Math.max(4, fontSize * 0.625);
}
/** Per-line height estimate for word-wrapped text — fontSize × 1.3
 * matches Excalidraw's `LINE_HEIGHT` for bound text. */
function estLineHeight(fontSize: number): number {
  return Math.ceil(fontSize * 1.3);
}

function acTextFit(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const containerById = new Map<string, ACElement>();
  for (const el of elements) {
    if (el.id && (el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond')) {
      containerById.set(el.id, el);
    }
  }
  // ---- Mode (A): post-conversion bound text vs container bbox ----
  for (const el of elements) {
    if (el.type !== 'text') continue;
    if (typeof el.containerId !== 'string' || el.containerId.length === 0) continue;
    const container = containerById.get(el.containerId);
    if (!container) continue;
    const containerBox = bboxOf(container);
    const textBox = bboxOf(el);
    if (!containerBox || !textBox) continue;
    if (!bboxContains(containerBox, textBox, BOUND_TEXT_PADDING)) {
      out.push({
        id: 'AC-TEXT-FIT',
        severity: 'FAIL',
        message: `Bound text ${el.id ?? '?'} (${formatBox(textBox)}) escapes container ${el.containerId} (${formatBox(containerBox)}). Use Excalidraw's native label sugar so the renderer auto-wraps.`,
        elementIds: [el.id ?? '', el.containerId],
      });
    }
  }
  // ---- Mode (B): pre-conversion `label:` sugar vs rect dimensions ----
  // For each rect/ellipse/diamond carrying a `label:` sugar, estimate
  // the longest unbreakable token's width and the wrapped line count.
  // Fire if any single word can't fit horizontally OR if the wrapped
  // text won't fit vertically. Catches the "agent declared too-small
  // rect for label" case BEFORE the renderer materializes the bound
  // text — so the agent can self-correct via look_at_scene + the AC's
  // surfaced MCP error.
  for (const el of elements) {
    if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'diamond') continue;
    if (!el.label || typeof el.label.text !== 'string' || el.label.text.length === 0) continue;
    if (typeof el.width !== 'number' || typeof el.height !== 'number') continue;
    const fontSize = typeof el.label.fontSize === 'number' ? el.label.fontSize : 16;
    const innerW = el.width - 2 * BOUND_TEXT_PADDING;
    const innerH = el.height - 2 * BOUND_TEXT_PADDING;
    const charW = estCharWidth(fontSize);
    const lineH = estLineHeight(fontSize);
    // Find the longest UNWRAPPABLE token. If a single word (no
    // whitespace inside) is wider than innerW, no wrapping algorithm
    // can rescue it — that's a hard fail.
    const words = el.label.text.split(/\s+/).filter(Boolean);
    let longestWordW = 0;
    for (const w of words) {
      const ww = w.length * charW;
      if (ww > longestWordW) longestWordW = ww;
    }
    if (longestWordW > innerW) {
      out.push({
        id: 'AC-TEXT-FIT',
        severity: 'FAIL',
        message: `Label "${el.label.text.slice(0, 40)}..." has a word ~${Math.round(longestWordW)}px wide; rect ${el.id ?? '?'} interior is ${Math.round(innerW)}px. Will clip on render. Widen the rect or shorten the word.`,
        elementIds: [el.id ?? ''],
      });
      continue;
    }
    // Greedy wrap to estimate line count at innerW, then check
    // total stacked height ≤ innerH. Honors author-supplied `\n`.
    const totalLines = countWrappedLines(el.label.text, charW, innerW);
    const totalTextH = totalLines * lineH;
    if (totalTextH > innerH) {
      out.push({
        id: 'AC-TEXT-FIT',
        severity: 'FAIL',
        message: `Label "${el.label.text.slice(0, 40)}..." wraps to ${totalLines} lines (~${totalTextH}px tall); rect ${el.id ?? '?'} interior is ${Math.round(innerH)}px. Will clip vertically. Grow rect height or shorten label.`,
        elementIds: [el.id ?? ''],
      });
    }
  }
  return out;
}

/** Greedy word-wrap counter — given a label.text, char width, and
 * interior width, return the number of lines the text will occupy
 * after wrap. Honors author-supplied `\n` as forced line breaks. */
function countWrappedLines(text: string, charW: number, innerW: number): number {
  const explicitLines = text.split('\n');
  let total = 0;
  for (const line of explicitLines) {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      total += 1;
      continue;
    }
    let cur = '';
    let lineCount = 0;
    for (const w of words) {
      const trial = cur ? cur + ' ' + w : w;
      if (trial.length * charW <= innerW || cur === '') {
        cur = trial;
      } else {
        lineCount += 1;
        cur = w;
      }
    }
    if (cur) lineCount += 1;
    total += lineCount;
  }
  return total;
}

function formatBox(b: BBox): string {
  return `x=${Math.round(b.xMin)}..${Math.round(b.xMax)}, y=${Math.round(b.yMin)}..${Math.round(b.yMax)}`;
}

// ----------------------------------------------------------------------
// AC-FREE-TEXT-CLEAR (WARN) — annotation text drawn over a content
// shape's interior. Legitimate placement is OUTSIDE every content shape
// (footnote-style) or as an INLINE annotation that's tagged
// `customData.fathomKind: 'wb-annotation'` AND whose container link is
// explicit. WARN, not FAIL, because legitimate exceptions exist (a
// title line drawn intentionally on top of a banner zone, etc.) — the
// human reviewer can decide.
// ----------------------------------------------------------------------

function acFreeTextClear(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const contentBoxes: Array<{ id: string; bb: BBox }> = [];
  for (const el of elements) {
    if (!isContentShape(el)) continue;
    if (!el.id) continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    contentBoxes.push({ id: el.id, bb });
  }
  for (const el of elements) {
    if (!isFreeText(el)) continue;
    // Whitelist: titles, annotations, edge labels — these are
    // explicitly allowed to float anywhere.
    const fk = el.customData?.fathomKind as string | undefined;
    if (fk === 'wb-title' || fk === 'wb-annotation' || fk === 'wb-summary') continue;
    // v3.2.1 — whitelist render-internal text that's positioned-inside
    // by design: drill glyphs (⌖ on top of drillable rect), callout tag
    // chips and body text (positioned inside the callout box). These
    // are NOT free text the user accidentally drew over content; they
    // are part of the renderer's compound primitives.
    if (
      fk === 'wb-drill-glyph' ||
      fk === 'wb-callout-tag' ||
      fk === 'wb-callout-body' ||
      fk === 'wb-zone-label'
    )
      continue;
    const tb = bboxOf(el);
    if (!tb) continue;
    for (const c of contentBoxes) {
      if (boxesOverlap(c.bb, tb, 0.5)) {
        out.push({
          id: 'AC-FREE-TEXT-CLEAR',
          severity: 'WARN',
          message: `Free text ${el.id ?? '?'} ("${(el.text ?? '').slice(0, 40)}") sits on top of content shape ${c.id}. Either bind it via containerId or move it clear of the shape.`,
          elementIds: [el.id ?? '', c.id],
        });
        break; // one report per offending text is enough
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-EDGE-NO-CROSS (FAIL) — no arrow polyline crosses a content shape
// that is not its endpoint. Endpoint detection is via proximity to the
// arrow's first/last point (within 4 px), not via Excalidraw's
// startBinding/endBinding (those aren't on our minimal element type).
// ----------------------------------------------------------------------

function acEdgeNoCross(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const contentBoxes: Array<{ id: string; bb: BBox }> = [];
  for (const el of elements) {
    if (!isContentShape(el)) continue;
    if (!el.id) continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    contentBoxes.push({ id: el.id, bb });
  }
  for (const el of elements) {
    if (el.type !== 'arrow') continue;
    const poly = arrowPolyline(el);
    if (poly.length < 2) continue;
    // Identify endpoints by proximity (4 px slack handles arrow gap).
    const endpointIds = new Set<string>();
    const first = poly[0];
    const last = poly[poly.length - 1];
    let nearestStart: { id: string; d: number } | null = null;
    let nearestEnd: { id: string; d: number } | null = null;
    for (const c of contentBoxes) {
      const ds = pointDistanceToBox(first, c.bb);
      const de = pointDistanceToBox(last, c.bb);
      if (!nearestStart || ds < nearestStart.d) nearestStart = { id: c.id, d: ds };
      if (!nearestEnd || de < nearestEnd.d) nearestEnd = { id: c.id, d: de };
    }
    if (nearestStart && nearestStart.d < 4) endpointIds.add(nearestStart.id);
    if (nearestEnd && nearestEnd.d < 4) endpointIds.add(nearestEnd.id);
    let crossed = false;
    for (let i = 0; i < poly.length - 1 && !crossed; i += 1) {
      const seg0 = poly[i];
      const seg1 = poly[i + 1];
      for (const c of contentBoxes) {
        if (endpointIds.has(c.id)) continue;
        if (segmentCrossesBox(seg0, seg1, c.bb)) {
          out.push({
            id: 'AC-EDGE-NO-CROSS',
            severity: 'FAIL',
            message: `Edge ${el.id ?? '?'} crosses non-endpoint shape ${c.id}.`,
            elementIds: [el.id ?? '', c.id],
          });
          crossed = true;
          break;
        }
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-DOUBLE-BIND (FAIL) — no shape has BOTH the `label:` sugar AND a
// separate text element bound via `containerId`. Coexistence risks
// Excalidraw double-rendering or silent drop.
// ----------------------------------------------------------------------

function acDoubleBind(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const containerIdsOfTexts = new Set<string>();
  for (const e of elements) {
    if (e.type === 'text' && typeof e.containerId === 'string' && e.containerId.length > 0) {
      containerIdsOfTexts.add(e.containerId);
    }
  }
  for (const e of elements) {
    if (e.type !== 'rectangle' && e.type !== 'ellipse' && e.type !== 'diamond') continue;
    if (!e.id) continue;
    const hasLabel = e.label !== undefined && e.label !== null;
    const hasBoundText = containerIdsOfTexts.has(e.id);
    if (hasLabel && hasBoundText) {
      out.push({
        id: 'AC-DOUBLE-BIND',
        severity: 'FAIL',
        message: `Shape ${e.id} has BOTH inline label and a text child via containerId. Pick one.`,
        elementIds: [e.id],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-NO-PSEUDO (FAIL) — no `wb-camera` (or any other pseudo-element
// the renderer should have stripped) survives into the rendered scene.
// If one does, the user sees a phantom rectangle that does nothing on
// click — the camera-pseudo has bbox + style but no semantics.
// ----------------------------------------------------------------------

const PSEUDO_KINDS: Set<string> = new Set(['wb-camera']);

function acNoSurvivingPseudo(elements: readonly ACElement[]): ACViolation[] {
  const offenders = elements.filter((e) => {
    const fk = e.customData?.fathomKind;
    return typeof fk === 'string' && PSEUDO_KINDS.has(fk);
  });
  if (offenders.length === 0) return [];
  return [
    {
      id: 'AC-NO-PSEUDO',
      severity: 'FAIL',
      message: `Pseudo-element(s) survived strip pass: ${offenders.length} of kind ${[...new Set(offenders.map((o) => o.customData?.fathomKind))].join(', ')}.`,
      elementIds: offenders.map((o) => o.id ?? '').filter(Boolean),
    },
  ];
}

// ----------------------------------------------------------------------
// Reporting helpers — used by the renderer to surface violations.
// ----------------------------------------------------------------------

/** One-line summary suitable for a console.error / toast. */
export function formatViolation(v: ACViolation): string {
  const idsTail = v.elementIds && v.elementIds.length > 0 ? ` [${v.elementIds.join(', ')}]` : '';
  return `${v.id} (${v.severity}): ${v.message}${idsTail}`;
}

/** Run validateScene + log to console. Returns true if any FAIL
 * violations occurred (caller may decide to abort scene-load). */
export function reportViolations(elements: readonly ACElement[], hints?: ACHints): boolean {
  const { fails, warns } = validateScene(elements, hints);
  for (const v of fails) console.error('[Whiteboard AC] ' + formatViolation(v));
  for (const v of warns) console.warn('[Whiteboard AC] ' + formatViolation(v));
  return fails.length > 0;
}

// ----------------------------------------------------------------------
// AC-MULTI-SECTION (FAIL when input has signals; WARN otherwise)
// — critic rubric rule 5/6. If the source paper has math equations
// or a thesis worth promoting, the agent should be authoring
// multi-section. A single-section render of a paper-with-equations is
// the regression team-lead REJECTED on 2026-04-26.
// ----------------------------------------------------------------------

function acMultiSection(elements: readonly ACElement[], hints?: ACHints): ACViolation[] {
  // Count distinct sections by sectionId on wb-section header elements.
  const sectionIds = new Set<string>();
  for (const el of elements) {
    const cd = el.customData;
    if (!cd) continue;
    if (cd.fathomKind === 'wb-section' && (cd as { isHeader?: boolean }).isHeader === true) {
      const sid = (cd as { sectionId?: string }).sectionId;
      if (sid) sectionIds.add(sid);
    }
  }
  const sectionCount = sectionIds.size;
  if (sectionCount >= 2) return [];
  // Single-section (or zero-section): only fire when the input doc
  // says we should have multi-section content.
  const wantMulti = hints?.hasMathSignal === true || hints?.hasThesisSignal === true;
  if (!wantMulti) return [];
  return [
    {
      id: 'AC-MULTI-SECTION',
      severity: 'FAIL',
      message:
        `Paper has math/thesis signals but render has only ${sectionCount} section(s). ` +
        `Author at least 2 sections (e.g. one workflow + one math callout, or one workflow + one KEY IDEA). ` +
        `Use create_section to start each new section.`,
    },
  ];
}

// ----------------------------------------------------------------------
// AC-ZONE-PER-SECTION (WARN) — critic rubric rule 1. Each section
// should start with at least one background zone to do the
// categorization. Zones-first is the canonical first design move.
// ----------------------------------------------------------------------

function acZonePerSection(elements: readonly ACElement[]): ACViolation[] {
  // Map sectionId → has at least one wb-zone child
  const sectionsWithZone = new Set<string>();
  const allSections = new Map<string, string>(); // sectionId → display name
  for (const el of elements) {
    const cd = el.customData;
    if (!cd) continue;
    const sid = (cd as { sectionId?: string }).sectionId;
    if (!sid) continue;
    if (cd.fathomKind === 'wb-section' && (cd as { isHeader?: boolean }).isHeader) {
      const title = (cd as { title?: string }).title ?? sid;
      const number = (cd as { sectionNumber?: number }).sectionNumber;
      allSections.set(sid, number ? `${number}. ${title}` : title);
    }
    if (cd.fathomKind === 'wb-zone') {
      sectionsWithZone.add(sid);
    }
  }
  const out: ACViolation[] = [];
  for (const [sid, name] of allSections.entries()) {
    if (sectionsWithZone.has(sid)) continue;
    out.push({
      id: 'AC-ZONE-PER-SECTION',
      severity: 'WARN',
      message:
        `Section "${name}" has no background zone. Per critic rule 1, the first design move is to drop 2-3 conceptual zones (create_background_zone) before placing inner shapes.`,
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-ROLE-COLOR-MATCH (FAIL) — critic rubric rule 2. Color = role.
// A node tagged role:input must be filled with the input pastel
// (#a5d8ff). Mismatch is a semantic-load violation.
// ----------------------------------------------------------------------

const ROLE_PASTEL: Record<string, string> = {
  input: '#a5d8ff',
  output: '#b2f2bb',
  process: '#d0bfff',
  math: '#fff3bf',
  noise: '#ffc9c9',
  neutral: '#fcfaf5',
};

function acRoleColorMatch(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  for (const el of elements) {
    const cd = el.customData;
    if (!cd || cd.fathomKind !== 'wb-node') continue;
    const role = (cd as { role?: string }).role;
    if (!role) continue;
    const expectedFill = ROLE_PASTEL[role];
    if (!expectedFill) continue;
    const actualFill = (el as { backgroundColor?: string }).backgroundColor;
    if (typeof actualFill !== 'string') continue;
    if (actualFill.toLowerCase() !== expectedFill.toLowerCase()) {
      out.push({
        id: 'AC-ROLE-COLOR-MATCH',
        severity: 'FAIL',
        message:
          `Node ${el.id ?? '?'} has role="${role}" but backgroundColor="${actualFill}" — should be "${expectedFill}". ` +
          `Color carries semantic load (critic rule 2): ${role} → ${expectedFill}.`,
        elementIds: [el.id ?? ''],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-COLOR-ROLE-CONSISTENCY (FAIL) — critic round 5 ask. Within any
// background zone, at most ONE node may be green (role:output) — the
// terminal node of that zone (the final delivered artifact). Multiple
// green nodes inside a zone violate the color-as-role principle: green
// means "success / final output", not "this lives inside the OUTPUT
// zone." A 5-stage GENERATE pipeline whose every node is green destroys
// the green=terminal signal.
//
// Detection: for each wb-zone bbox, find all wb-node elements whose
// bbox sits inside it. Count how many have backgroundColor matching the
// green pastel (#b2f2bb). If >1, FAIL — the agent picked color by zone-
// membership rather than per-node role.
//
// The intent is NOT to enforce zone-local terminal detection (that
// would require arrow-graph analysis); the simpler "no zone may have
// >1 green node" predicate catches the regression class without
// false-positive risk on legitimate designs (which always have exactly
// 0 or 1 green node per zone).
// ----------------------------------------------------------------------

const GREEN_FILL = '#b2f2bb';

function acColorRoleConsistency(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  // Collect zones with their bboxes.
  const zones: Array<{ id: string; label: string; bb: BBox }> = [];
  for (const el of elements) {
    const cd = el.customData;
    if (!cd || cd.fathomKind !== 'wb-zone') continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    const label = ((el as { label?: { text?: string } }).label?.text)
      ?? ((cd as { label?: string }).label as string | undefined)
      ?? (el.id ?? 'zone');
    zones.push({ id: el.id ?? '?', label, bb });
  }
  if (zones.length === 0) return [];
  // For each zone, find green nodes inside.
  for (const zone of zones) {
    const greenInside: Array<{ id: string; label: string }> = [];
    for (const el of elements) {
      const cd = el.customData;
      if (!cd || cd.fathomKind !== 'wb-node') continue;
      const fill = (el as { backgroundColor?: string }).backgroundColor;
      if (typeof fill !== 'string') continue;
      if (fill.toLowerCase() !== GREEN_FILL) continue;
      const nb = bboxOf(el);
      if (!nb) continue;
      // Node is "inside" zone if its center sits within the zone bbox.
      const cx = (nb.xMin + nb.xMax) / 2;
      const cy = (nb.yMin + nb.yMax) / 2;
      if (cx < zone.bb.xMin || cx > zone.bb.xMax) continue;
      if (cy < zone.bb.yMin || cy > zone.bb.yMax) continue;
      const nodeLabel = ((el as { label?: { text?: string } }).label?.text)
        ?? (el.text ?? '')
        ?? (el.id ?? 'node');
      greenInside.push({ id: el.id ?? '?', label: nodeLabel.toString().slice(0, 40) });
    }
    if (greenInside.length <= 1) continue;
    out.push({
      id: 'AC-COLOR-ROLE-CONSISTENCY',
      severity: 'FAIL',
      message:
        `Zone "${zone.label}" (${zone.id}) contains ${greenInside.length} green nodes: ` +
        greenInside.map((n) => `${n.id} ("${n.label}")`).join(', ') +
        `. Per critic rule 2, green = success / final output / KEY IDEA — at most ONE node per zone may be green (the terminal artifact). ` +
        `Intermediate transformation nodes (e.g. SS-Flow, SLAT-Flow) must be PURPLE (role=process), not green-because-they-live-in-the-output-zone. ` +
        `Zone-fill-color and node-fill-color are independent decisions — both driven by their own per-element role.`,
      elementIds: [zone.id, ...greenInside.map((n) => n.id)],
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-CAMERA-PRESENT (WARN) — critic rubric rule 3 ("camera is narration").
// A multi-section render with zero `set_camera` calls means the agent
// authored a static graphic, not a lecturer's storyboard. Camera moves
// don't draw pixels but their absence signals missed-narration.
// ----------------------------------------------------------------------

function acCameraPresent(elements: readonly ACElement[]): ACViolation[] {
  // Count distinct sections by sectionId on header elements.
  const sectionIds = new Set<string>();
  let cameraCount = 0;
  for (const el of elements) {
    const cd = el.customData;
    if (!cd) continue;
    if (cd.fathomKind === 'wb-section' && (cd as { isHeader?: boolean }).isHeader === true) {
      const sid = (cd as { sectionId?: string }).sectionId;
      if (sid) sectionIds.add(sid);
    }
    if (cd.fathomKind === 'wb-camera') cameraCount += 1;
  }
  // Only fire when the render is multi-section. A single-section render
  // doesn't NEED a camera plan — the static frame IS the plan. Multi-
  // section means there's a sequence the agent should be narrating.
  if (sectionIds.size < 2) return [];
  if (cameraCount > 0) return [];
  return [
    {
      id: 'AC-CAMERA-PRESENT',
      severity: 'WARN',
      message:
        `Multi-section render (${sectionIds.size} sections) emitted zero set_camera calls. ` +
        `Per critic rule 3, camera is narration: plan a camera storyboard (title close-up → wide of arch → zoom into key block → wide → zoom into math → wide → KEY IDEA → wide). ` +
        `Use set_camera for each frame.`,
    },
  ];
}

// ----------------------------------------------------------------------
// AC-MATH-NO-CONTAINER (FAIL) — critic rubric rule 6, "Formula / piece
// of math" row: equations must be `create_text` with `fontFamily="mono"`,
// **NOT** wrapped inside a content rectangle. The user critique was
// explicit: "Big text element + colored box around the right-hand side,
// NO shapes." A monospace text element with `containerId` set to a
// content shape is the violation pattern.
// ----------------------------------------------------------------------

const FONT_FAMILY_MONO = 3; // Excalidraw's Cascadia/mono code

function acMathNoContainer(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  // Build a lookup of content rect ids so we can identify when a text's
  // containerId points at a content shape (vs a zone, callout, etc.).
  const contentIds = new Set<string>();
  for (const el of elements) {
    if (!el.id) continue;
    if (isContentShape(el)) contentIds.add(el.id);
  }
  for (const el of elements) {
    if (el.type !== 'text') continue;
    if (el.fontFamily !== FONT_FAMILY_MONO) continue;
    if (typeof el.containerId !== 'string' || el.containerId.length === 0) continue;
    if (!contentIds.has(el.containerId)) continue;
    out.push({
      id: 'AC-MATH-NO-CONTAINER',
      severity: 'FAIL',
      message:
        `Math text ${el.id ?? '?'} ("${(el.text ?? '').slice(0, 40)}") is bound to content shape ${el.containerId}. ` +
        `Per critic rule 6, equations must be free-standing create_text (fontFamily="mono") with at most a colored zone around the RHS — never inside a rect.`,
      elementIds: [el.id ?? '', el.containerId],
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-PROGRESSIVE-EMIT (WARN) — critic rubric rule 4. Array order is
// z-order is streaming order. The anti-pattern is "all rectangles
// first, then all text, then all arrows" — a sorted-by-type emission
// that destroys the build-an-idea-step-by-step animation feel.
//
// Detection: scan content elements (the ones the agent authored, not
// renderer-emitted decorations like zone-label-plates) and check
// whether their type sequence is non-interleaved. If we see
//   rectangle…rectangle…rectangle…arrow…arrow
// with no text/arrow interleaving, that's sorted-by-type.
//
// We restrict to "agent content" via the customData.fathomKind allow-
// list — wb-node, wb-edge, wb-callout, wb-zone, wb-section. Free
// renderer-internal elements (drill glyphs, citation chips, plates)
// don't have a narrative order and are excluded.
// ----------------------------------------------------------------------

const NARRATIVE_KINDS: Set<string> = new Set([
  'wb-node',
  'wb-edge',
  'wb-zone',
  'wb-callout',
  'wb-section',
]);

function acProgressiveEmit(elements: readonly ACElement[]): ACViolation[] {
  // Build the narrative-element type sequence in array order.
  const seq: Array<'shape' | 'arrow' | 'text'> = [];
  for (const el of elements) {
    const fk = el.customData?.fathomKind;
    if (!fk || !NARRATIVE_KINDS.has(fk)) continue;
    if (el.type === 'arrow') seq.push('arrow');
    else if (el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond') seq.push('shape');
    else continue;
  }
  // Need a baseline — at least 4 narrative shapes + arrows. Below that,
  // the diagram is too small to grade ordering on.
  if (seq.length < 4) return [];
  // Count arrows and shapes.
  const shapeCount = seq.filter((t) => t === 'shape').length;
  const arrowCount = seq.filter((t) => t === 'arrow').length;
  if (shapeCount < 2 || arrowCount < 1) return [];
  // Anti-pattern: arrows-after-all-shapes. If the LAST shape index is
  // strictly less than the FIRST arrow index AND there are 3+ shapes
  // and 2+ arrows, the agent emitted "all shapes then all arrows".
  let lastShapeIdx = -1;
  let firstArrowIdx = -1;
  for (let i = 0; i < seq.length; i += 1) {
    if (seq[i] === 'shape') lastShapeIdx = i;
    if (seq[i] === 'arrow' && firstArrowIdx === -1) firstArrowIdx = i;
  }
  if (firstArrowIdx === -1 || lastShapeIdx === -1) return [];
  if (lastShapeIdx >= firstArrowIdx) return [];
  if (shapeCount < 3 || arrowCount < 2) return [];
  return [
    {
      id: 'AC-PROGRESSIVE-EMIT',
      severity: 'WARN',
      message:
        `Narrative elements emitted in sorted-by-type order: ${shapeCount} shapes (positions 0..${lastShapeIdx}) then ${arrowCount} arrows (starting at ${firstArrowIdx}). ` +
        `Per critic rule 4, emit shape → its outgoing arrow → next shape, so the streaming order reads as building an idea step by step. ` +
        `Author shape and arrow back-to-back in your tool-call sequence.`,
    },
  ];
}

// ----------------------------------------------------------------------
// AC-TEXT-NO-TRUNCATION (FAIL) — critic round 1, rule 1 (zones group
// meaning) + rule 5 by extension (lecturer narration). The previous
// rendered scene showed corrupted/truncated zone titles ("EMPUTS",
// "RECONVTAGUN", "GENERATE (COARSE-TO-FI…") and clipped section
// headers ("…push the loss back as a veloc"). The source strings in
// the scene JSON were correct — the corruption happened in the render
// path (Excalifont width-based ellipsizing on autoResize:false text).
//
// AC predicate: for every text element with fathomKind ∈
// {wb-zone-label, wb-section header/subheader}, predict whether the
// source string will fit in the declared `width` at the declared
// `fontSize` using the same Excalifont char-width estimate the AC
// suite already calibrated. If the longest unbreakable token's
// estimated width exceeds the declared width minus 2px padding, the
// renderer will clip — fire FAIL. Cannot trust autoResize:false text
// to wrap; it will silently truncate.
//
// Char-width estimate: Excalifont @ 11px ≈ 6.875 px/char (slope 0.625
// already used in mode-B of AC-TEXT-FIT). For headers @ 22px the
// estimate is 13.75 px/char.
// ----------------------------------------------------------------------

/** Conservative Excalifont char-width estimate calibrated for UPPERCASE
 * labels. Mixed-case slope is 0.625 (estCharWidth above) which matches
 * the MCP wrapper's existing fitNodeSize calibration. UPPERCASE characters
 * lack narrow descenders/ascenders and average ~50% wider per glyph.
 * Used by AC-TEXT-NO-TRUNCATION when the label is detected as ALL CAPS. */
function estCharWidthUppercase(fontSize: number): number {
  return Math.max(5, fontSize * 0.95);
}

function acTextNoTruncation(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const fk = el.customData?.fathomKind;
    // Load-bearing labels only — zone titles + section header/subheader.
    // Free annotations and callout-internal text use word-wrap and are
    // covered by AC-TEXT-FIT.
    const isZoneLabel = fk === 'wb-zone-label';
    const isSectionHeader =
      fk === 'wb-section' &&
      ((el.customData as { isHeader?: boolean })?.isHeader === true ||
        (el.customData as { isSubheader?: boolean })?.isSubheader === true);
    if (!isZoneLabel && !isSectionHeader) continue;
    const text = (el.text ?? '').trim();
    if (text.length === 0) continue;
    const declaredW = typeof el.width === 'number' ? el.width : 0;
    if (declaredW <= 0) continue;
    const fontSize = typeof el.fontSize === 'number' ? el.fontSize : 14;
    // Pick the right char-width estimate: zone labels are ALL CAPS
    // (the MCP wrapper uppercases them), so use the wider uppercase
    // slope. Section headers are mixed-case prose, use the standard
    // slope. Both are conservative — false positives prevent the
    // critic-graded "EMPUTS" failure.
    const isUppercase = isZoneLabel || text === text.toUpperCase();
    const charW = isUppercase ? estCharWidthUppercase(fontSize) : estCharWidth(fontSize);
    const innerW = Math.max(0, declaredW - 4); // 2px padding each side
    // Predicted full-string width (no wrap — these are autoResize:false
    // single-line elements per the MCP wrapper).
    const predictedW = text.length * charW;
    if (predictedW <= innerW) continue;
    // Renderer will clip. The element is load-bearing so this is FAIL.
    const role = isSectionHeader ? 'section header' : 'zone title';
    out.push({
      id: 'AC-TEXT-NO-TRUNCATION',
      severity: 'FAIL',
      message:
        `Load-bearing ${role} ${el.id ?? '?'} ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}") will truncate on render: ` +
        `~${Math.round(predictedW)}px wide at fontSize=${fontSize}${isUppercase ? ' (UPPERCASE — wider chars)' : ''}, but element width is only ${Math.round(innerW)}px (after padding). ` +
        `Renderer's autoResize:false will silently clip — the user reads "EMPUTS" instead of "INPUTS". ` +
        `Either shorten the string (zone titles ≤ 16 chars from a fixed vocabulary; headers fit canvas width) or break to a sub-line.`,
      elementIds: [el.id ?? ''],
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-PARAGRAPH-WIDTH-FIT (FAIL) — critic round 3 ask. Free-text
// paragraphs (annotations, equation explanations, multi-line free text)
// must fit inside their parent section's bounding box. The renderer
// does not auto-wrap autoResize:false text — it silently clips the
// right edge. Round 3 shipped 3 single-line equation explanations
// 240+ chars long; reader saw only the first ~100 chars before clip.
//
// Detection: for every free-text element (no containerId) belonging to
// a section (customData.sectionId set), the element's predicted width
// (longest line × char-width) must be ≤ section.width − 40 px padding.
// We honour explicit \n line breaks: each line is checked separately.
//
// We exclude: zone labels (covered by AC-TEXT-NO-TRUNCATION), section
// headers (same), callout-internal text (covered by AC-TEXT-FIT via
// the callout's containerId), and bound text (also AC-TEXT-FIT).
// ----------------------------------------------------------------------

const PARAGRAPH_PADDING = 40; // px each side, conservative

function acParagraphWidthFit(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const sectionBBoxBySid = new Map<string, BBox>();
  for (const el of elements) {
    const cd = el.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string } | undefined;
    if (cd?.fathomKind !== 'wb-section' || cd?.isHeader !== true) continue;
    const sid = cd.sectionId;
    if (!sid) continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    sectionBBoxBySid.set(sid, bb);
  }
  if (sectionBBoxBySid.size === 0) return [];

  for (const el of elements) {
    if (el.type !== 'text') continue;
    if (typeof el.containerId === 'string' && el.containerId.length > 0) continue;
    const cd = el.customData as { fathomKind?: string; sectionId?: string } | undefined;
    if (!cd) continue;
    const fk = cd.fathomKind;
    if (fk === 'wb-zone-label') continue;
    if (fk === 'wb-section') continue;
    if (fk === 'wb-callout-tag') continue;
    if (fk === 'wb-callout-body') continue;
    const sid = cd.sectionId;
    if (!sid) continue;
    const sectionBB = sectionBBoxBySid.get(sid);
    if (!sectionBB) continue;
    const text = (el.text ?? '').trim();
    if (text.length === 0) continue;
    const fontSize = typeof el.fontSize === 'number' ? el.fontSize : 14;
    const isMono = el.fontFamily === 3;
    const charW = isMono ? fontSize * 0.62 : estCharWidth(fontSize);
    const lines = text.split('\n');
    let longestLineLen = 0;
    let longestLineText = '';
    for (const line of lines) {
      if (line.length > longestLineLen) {
        longestLineLen = line.length;
        longestLineText = line;
      }
    }
    const predictedW = longestLineLen * charW;
    const elX = typeof el.x === 'number' ? el.x : sectionBB.xMin;
    const lineRightEdge = elX + predictedW;
    const allowedRightEdge = sectionBB.xMax - PARAGRAPH_PADDING;
    if (lineRightEdge <= allowedRightEdge) continue;
    const overflowPx = Math.round(lineRightEdge - allowedRightEdge);
    out.push({
      id: 'AC-PARAGRAPH-WIDTH-FIT',
      severity: 'FAIL',
      message:
        `Paragraph text ${el.id ?? '?'} in section ${sid} overflows section width by ${overflowPx}px. ` +
        `Longest line is ${longestLineLen} chars at fontSize=${fontSize}${isMono ? ' (mono)' : ''} ≈ ${Math.round(predictedW)}px wide; ` +
        `placed at x=${Math.round(elX)} so right edge is ${Math.round(lineRightEdge)}px, but section right edge minus padding is ${Math.round(allowedRightEdge)}px. ` +
        `Renderer (autoResize:false) will clip mid-word. ` +
        `Line preview: "${longestLineText.slice(0, 80)}${longestLineText.length > 80 ? '…' : ''}". ` +
        `Fix: insert \\n line breaks inside the create_text, OR split into multiple stacked create_text calls (one per equation/concept), OR reduce fontSize and re-budget.`,
      elementIds: [el.id ?? ''],
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-SECTION-NUMBER-SEQUENTIAL (FAIL) — critic round 3 ask. Whiteboard
// section numbers must be 1, 2, 3, … with no gaps. Round 3 shipped
// 1/3/5 because the wrapper's section-counter accidentally counted
// header + subheader twice; the wrapper bug is fixed but this AC
// guards against any future regression by reading the actual rendered
// sectionNumber values off wb-section header customData.
// ----------------------------------------------------------------------

function acSectionNumberSequential(elements: readonly ACElement[]): ACViolation[] {
  const numbersById = new Map<string, number>();
  for (const el of elements) {
    const cd = el.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string; sectionNumber?: number } | undefined;
    if (cd?.fathomKind !== 'wb-section' || cd?.isHeader !== true) continue;
    const sid = cd.sectionId;
    const n = cd.sectionNumber;
    if (!sid || typeof n !== 'number') continue;
    numbersById.set(sid, n);
  }
  if (numbersById.size === 0) return [];
  const numbers = Array.from(numbersById.values()).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) {
      return [
        {
          id: 'AC-SECTION-NUMBER-SEQUENTIAL',
          severity: 'FAIL',
          message:
            `Section numbers are non-sequential: got [${numbers.join(', ')}], expected [${numbers.map((_, j) => j + 1).join(', ')}]. ` +
            `Per critic round-3 rule, whiteboard sections must be numbered 1, 2, 3, … starting at 1 with no gaps, regardless of what numbering the source paper uses. ` +
            `Verbatim user critique: "we mentioned 1, 3, and 5, whereas 2 and 4". ` +
            `Root cause is usually the wrapper's section-counter or an agent that called create_section once and then mutated the header text — never edit the rendered section number, let the wrapper assign it.`,
          elementIds: Array.from(numbersById.keys()),
        },
      ];
    }
  }
  return [];
}

// ----------------------------------------------------------------------
// AC-TEXT-NO-COLLISION (FAIL) — critic round 4 ask. Two free-text
// elements whose bboxes overlap by >10% of the smaller area render as
// double-stamped garbled glyphs. Round-4 shipped Eq. 6 twice at the same
// (x=80, y=820) — once from a wb-section that the agent abandoned, once
// from the wb-section it ultimately built; the wrapper doesn't dedupe
// across sections, and the agent's hardcoded y=820 in both create_text
// calls put them on top of each other.
//
// Detection: O(N²) pairwise scan of all free-text elements (no
// containerId — bound text is constrained by AC-TEXT-FIT). Skip
// label-class kinds since they're vertically offset by the wrapper:
// {wb-zone-label, wb-section header/subheader, wb-callout-tag,
// wb-callout-body}. The remaining narrative free text is the candidate
// pool. Threshold 10%-of-smaller-area chosen so deliberate near-
// adjacencies (e.g. equation + RHS-tint zone) don't trigger; only true
// double-stamping does.
// ----------------------------------------------------------------------

function acTextNoCollision(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const candidates: Array<{ id: string; bb: BBox; text: string; area: number }> = [];
  for (const el of elements) {
    if (el.type !== 'text') continue;
    if (typeof el.containerId === 'string' && el.containerId.length > 0) continue;
    const fk = el.customData?.fathomKind;
    if (fk === 'wb-zone-label') continue;
    if (fk === 'wb-section') continue;
    if (fk === 'wb-callout-tag') continue;
    if (fk === 'wb-callout-body') continue;
    const bb = bboxOf(el);
    if (!bb) continue;
    const area = (bb.xMax - bb.xMin) * (bb.yMax - bb.yMin);
    if (area <= 0) continue;
    candidates.push({ id: el.id ?? '?', bb, text: (el.text ?? '').slice(0, 60), area });
  }
  if (candidates.length < 2) return [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const a2 = a.bb;
      const b2 = b.bb;
      if (a2.xMax <= b2.xMin || b2.xMax <= a2.xMin) continue;
      if (a2.yMax <= b2.yMin || b2.yMax <= a2.yMin) continue;
      const iw = Math.min(a2.xMax, b2.xMax) - Math.max(a2.xMin, b2.xMin);
      const ih = Math.min(a2.yMax, b2.yMax) - Math.max(a2.yMin, b2.yMin);
      const ov = iw * ih;
      const minArea = Math.min(a.area, b.area);
      const ratio = ov / minArea;
      if (ratio < 0.10) continue;
      out.push({
        id: 'AC-TEXT-NO-COLLISION',
        severity: 'FAIL',
        message:
          `Free-text elements ${a.id} and ${b.id} overlap by ${Math.round(ratio * 100)}% of the smaller bbox. ` +
          `When two text elements share interior pixels, the renderer paints both and the reader sees garbled glyphs (Eq. 6 in round-4: "L〵S̺SIN" / "DreamSim((O_l(O_l))"). ` +
          `Cause is usually a stale element left behind after a section restart or a retry-replace that didn't delete the prior version. ` +
          `Fix: clear_scene + rebuild OR delete the stale element via mutate_element({delete:true}) before re-emitting.`,
        elementIds: [a.id, b.id],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-CALLOUT-BODY-FIT (FAIL) — round 7 user critique 2026-04-27 ("the
// text in the box three is coming out of the box"). The MCP wrapper
// emits callout body text as a FREE text element (containerId=null)
// positioned inside the callout rect. Existing AC-TEXT-FIT only checks
// bound text. AC-PARAGRAPH-WIDTH-FIT explicitly skips wb-callout-body.
// So the callout-body had zero structural overflow protection until
// now — the user's critique is the structural ask we owe them.
//
// Predicate: for every text element with fathomKind ∈ {wb-callout-body,
// wb-callout-tag}, find the parent wb-callout (the rect whose bbox
// contains the text's center). Predict wrapped line count of the body
// text at the callout's inner width (callout.width − 2*pad) using the
// per-char-width estimate calibrated for Excalifont. FAIL if predicted
// height > callout's bottom edge − pad − text.y, OR if any single line's
// predicted width > inner width.
//
// Geometry constants must match the wrapper's create_callout_box at
// src/main/mcp/whiteboard-mcp.ts (CALLOUT_BODY_PAD_X=20, body fontSize
// 16, line-height 1.5×, char-width ~10 px @ 16). Mismatch between the
// wrapper's sizer and this predicate's check will produce noise, so they
// are deliberately the same numbers.
// ----------------------------------------------------------------------

const CALLOUT_BODY_PAD_X_AC = 20;
const CALLOUT_BODY_PAD_Y_BOTTOM_AC = 24;
const CALLOUT_BODY_FONTSIZE_AC = 16;
const CALLOUT_BODY_LINE_HEIGHT_AC = Math.ceil(CALLOUT_BODY_FONTSIZE_AC * 1.5);

function predictWrappedLines(text: string, charWidth: number, innerWidth: number): { lines: number; longestLineWidth: number } {
  const paragraphs = text.split('\n');
  let totalLines = 0;
  let longestLineWidth = 0;
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      totalLines += 1;
      continue;
    }
    let current = '';
    let curLines = 0;
    for (const w of words) {
      const trial = current ? current + ' ' + w : w;
      const trialW = trial.length * charWidth;
      if (trialW <= innerWidth || current === '') {
        current = trial;
      } else {
        curLines += 1;
        const finalisedW = current.length * charWidth;
        if (finalisedW > longestLineWidth) longestLineWidth = finalisedW;
        current = w;
      }
    }
    if (current) {
      curLines += 1;
      const finalisedW = current.length * charWidth;
      if (finalisedW > longestLineWidth) longestLineWidth = finalisedW;
    }
    totalLines += Math.max(1, curLines);
  }
  return { lines: totalLines, longestLineWidth };
}

function acCalloutBodyFit(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  // Index callouts by id with their bboxes.
  const callouts: Array<{ id: string; bb: BBox }> = [];
  for (const el of elements) {
    if (el.customData?.fathomKind !== 'wb-callout') continue;
    const bb = bboxOf(el);
    if (!bb || !el.id) continue;
    callouts.push({ id: el.id, bb });
  }
  if (callouts.length === 0) return [];
  // For each callout-body / callout-tag text element, find its parent
  // callout (bbox-contains-center) and check fit.
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const fk = el.customData?.fathomKind;
    if (fk !== 'wb-callout-body' && fk !== 'wb-callout-tag') continue;
    const tb = bboxOf(el);
    if (!tb) continue;
    const cx = (tb.xMin + tb.xMax) / 2;
    const cy = (tb.yMin + tb.yMax) / 2;
    const parent = callouts.find(
      (c) => cx >= c.bb.xMin && cx <= c.bb.xMax && cy >= c.bb.yMin && cy <= c.bb.yMax,
    );
    if (!parent) continue;
    const text = (el.text ?? '').trim();
    if (text.length === 0) continue;
    const fontSize = typeof el.fontSize === 'number' ? el.fontSize : CALLOUT_BODY_FONTSIZE_AC;
    // Per-char width: 0.625 × fontSize (matches estCharWidth above and
    // the wrapper's CALLOUT_BODY_CHAR_W=10 @ fontSize=16).
    const charW = Math.max(4, fontSize * 0.625);
    const lineH = Math.ceil(fontSize * 1.5);
    // Inner width = callout width − 2 × horizontal pad.
    const calloutWidth = parent.bb.xMax - parent.bb.xMin;
    const innerW = calloutWidth - 2 * CALLOUT_BODY_PAD_X_AC;
    if (innerW <= 0) continue;
    // Predict wrapped lines + longest single line width.
    const { lines, longestLineWidth } = predictWrappedLines(text, charW, innerW);
    // Check 1: any single wrapped line wider than innerW (would happen
    // only if a single unbreakable token is wider than innerW).
    if (longestLineWidth > innerW + 1) {
      out.push({
        id: 'AC-CALLOUT-BODY-FIT',
        severity: 'FAIL',
        message:
          `Callout-body text ${el.id ?? '?'} ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}") has a wrapped line ${Math.round(longestLineWidth)}px wide, ` +
          `but parent callout ${parent.id} inner width is ${Math.round(innerW)}px. The line will clip the right edge of the callout. ` +
          `User critique 2026-04-27: "text in box three is coming out of the box." Fix: shorten the body text or widen the callout.`,
        elementIds: [el.id ?? '', parent.id],
      });
    }
    // Check 2: predicted total height exceeds callout bottom.
    const predictedHeight = lines * lineH + 16;
    const textTopY = tb.yMin;
    const predictedBottomY = textTopY + predictedHeight;
    const calloutBottomMinusPad = parent.bb.yMax - CALLOUT_BODY_PAD_Y_BOTTOM_AC;
    if (predictedBottomY > calloutBottomMinusPad + 1) {
      const overflowPx = Math.round(predictedBottomY - calloutBottomMinusPad);
      out.push({
        id: 'AC-CALLOUT-BODY-FIT',
        severity: 'FAIL',
        message:
          `Callout-body text ${el.id ?? '?'} (${lines} wrapped lines × ${lineH}px line-height = ${predictedHeight}px) overflows callout ${parent.id} by ${overflowPx}px on the bottom edge. ` +
          `Body starts at y=${Math.round(textTopY)}, predicted bottom y=${Math.round(predictedBottomY)}, callout bottom minus pad y=${Math.round(calloutBottomMinusPad)}. ` +
          `User critique 2026-04-27: "text in box three is coming out of the box. We should have structural ways to make sure that this does not happen." ` +
          `Root cause is usually the callout wrapper sizing the box from raw \\n line count instead of width-aware wrap; the wrapper has been fixed to use wrapToWidth, so this AC firing means a future regression — investigate the wrapper.`,
        elementIds: [el.id ?? '', parent.id],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-CONTAINER-TEXT-FIT (FAIL) — round 8 critic ask 3, generalizes
// round-7's AC-CALLOUT-BODY-FIT. The rubric language at lines 240-253
// is explicit: "coverage must extend to ALL text-in-container element
// types — callout-body, callout-tag, zone-label, section-subtitle, node-
// body annotation, edge label inside an arrow band, etc." Round-7 only
// covered wb-callout-body; this AC generalizes the same width-aware-wrap
// + bottom-fit predicate to every text element with a visually-implied
// parent container.
//
// Implementation: a dispatch table mapping text-fathomKind → parent-
// fathomKind. For each text element matching a row in the table, find
// the parent container by bbox-contains-center, run the same wrap
// predict + width/height checks. Skip wb-callout-body (already covered
// by AC-CALLOUT-BODY-FIT) so we don't double-fail the same element.
// ----------------------------------------------------------------------

const CONTAINER_TEXT_FIT_DISPATCH: Array<{
  textKind: string;
  parentKind: string;
  padX: number;
  padBottom: number;
}> = [
  // Round-7 covered wb-callout-body separately; do NOT include here.
  { textKind: 'wb-zone-label',     parentKind: 'wb-zone',    padX: 8,  padBottom: 4 },
  { textKind: 'wb-node-question',  parentKind: 'wb-node',    padX: 0,  padBottom: 0 }, // sits BELOW the node, not inside; check width-only against node.width
  { textKind: 'wb-callout-tag',    parentKind: 'wb-callout', padX: 12, padBottom: 4 },
];

function acContainerTextFit(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  // Index parent containers by fathomKind.
  const containersByKind = new Map<string, Array<{ id: string; bb: BBox }>>();
  for (const el of elements) {
    const fk = el.customData?.fathomKind;
    if (typeof fk !== 'string') continue;
    if (fk !== 'wb-zone' && fk !== 'wb-node' && fk !== 'wb-callout') continue;
    const bb = bboxOf(el);
    if (!bb || !el.id) continue;
    const arr = containersByKind.get(fk) ?? [];
    arr.push({ id: el.id, bb });
    containersByKind.set(fk, arr);
  }
  if (containersByKind.size === 0) return [];

  for (const el of elements) {
    if (el.type !== 'text') continue;
    const fk = el.customData?.fathomKind;
    if (typeof fk !== 'string') continue;
    const rule = CONTAINER_TEXT_FIT_DISPATCH.find((r) => r.textKind === fk);
    if (!rule) continue;
    const parents = containersByKind.get(rule.parentKind) ?? [];
    if (parents.length === 0) continue;
    const tb = bboxOf(el);
    if (!tb) continue;
    const text = (el.text ?? '').trim();
    if (text.length === 0) continue;
    const fontSize = typeof el.fontSize === 'number' ? el.fontSize : 14;
    const isMono = el.fontFamily === 3;
    const charW = isMono ? fontSize * 0.62 : Math.max(4, fontSize * 0.625);

    if (rule.textKind === 'wb-node-question') {
      // Node-question sits OUTSIDE the node (below it). Use the node
      // identified by customData.nodeId rather than bbox-contains-center;
      // we want the node whose ID this question references, then assert
      // the question's width fits the node's width and the question's
      // text wrapping fits the question element's own height.
      const nodeId = (el.customData as { nodeId?: string } | undefined)?.nodeId;
      const parent = parents.find((p) => p.id === nodeId);
      if (!parent) continue;
      const innerW = parent.bb.xMax - parent.bb.xMin;
      const { lines, longestLineWidth } = predictWrappedLines(text, charW, innerW);
      const lineH = Math.ceil(fontSize * 1.4);
      const predictedHeight = lines * lineH + 4;
      const declaredHeight = tb.yMax - tb.yMin;
      if (longestLineWidth > innerW + 1) {
        out.push({
          id: 'AC-CONTAINER-TEXT-FIT',
          severity: 'FAIL',
          message:
            `wb-node-question ${el.id ?? '?'} ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}") ` +
            `has a wrapped line ${Math.round(longestLineWidth)}px wide vs node ${parent.id} width ${Math.round(innerW)}px. ` +
            `The "→ <question>" subtitle would clip the node's right edge. Shorten the question or widen the node.`,
          elementIds: [el.id ?? '', parent.id],
        });
      }
      if (predictedHeight > declaredHeight + 1) {
        const overflowPx = Math.round(predictedHeight - declaredHeight);
        out.push({
          id: 'AC-CONTAINER-TEXT-FIT',
          severity: 'FAIL',
          message:
            `wb-node-question ${el.id ?? '?'} predicted height ${predictedHeight}px exceeds declared height ${Math.round(declaredHeight)}px by ${overflowPx}px. ` +
            `The wrapper must size the question element to fit the wrapped text — investigate create_node_with_fitted_text question-emission code.`,
          elementIds: [el.id ?? ''],
        });
      }
      continue;
    }

    // Generic case (wb-zone-label, wb-callout-tag): text sits INSIDE
    // the parent's bbox. Find parent by bbox-contains-center.
    const cx = (tb.xMin + tb.xMax) / 2;
    const cy = (tb.yMin + tb.yMax) / 2;
    const parent = parents.find(
      (p) => cx >= p.bb.xMin && cx <= p.bb.xMax && cy >= p.bb.yMin && cy <= p.bb.yMax,
    );
    if (!parent) continue;
    const parentW = parent.bb.xMax - parent.bb.xMin;
    const innerW = parentW - 2 * rule.padX;
    if (innerW <= 0) continue;
    const { lines, longestLineWidth } = predictWrappedLines(text, charW, innerW);
    if (longestLineWidth > innerW + 1) {
      out.push({
        id: 'AC-CONTAINER-TEXT-FIT',
        severity: 'FAIL',
        message:
          `${rule.textKind} ${el.id ?? '?'} ("${text.slice(0, 60)}${text.length > 60 ? '…' : ''}") ` +
          `has a wrapped line ${Math.round(longestLineWidth)}px wide; parent ${rule.parentKind} ${parent.id} inner width is ${Math.round(innerW)}px. Will clip on render.`,
        elementIds: [el.id ?? '', parent.id],
      });
    }
    const lineH = Math.ceil(fontSize * 1.5);
    const predictedHeight = lines * lineH + 8;
    const textTopY = tb.yMin;
    const parentBottomMinusPad = parent.bb.yMax - rule.padBottom;
    if (textTopY + predictedHeight > parentBottomMinusPad + 1) {
      const overflowPx = Math.round(textTopY + predictedHeight - parentBottomMinusPad);
      out.push({
        id: 'AC-CONTAINER-TEXT-FIT',
        severity: 'FAIL',
        message:
          `${rule.textKind} ${el.id ?? '?'} (${lines} wrapped lines) overflows ${rule.parentKind} ${parent.id} bottom edge by ${overflowPx}px.`,
        elementIds: [el.id ?? '', parent.id],
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// AC-COMPONENT-HAS-QUESTION (FAIL) — round 8 user round-7 critique
// 2026-04-27 ("when we are listing the modules or different components,
// it might help to understand things in a way that asks what is the
// answer that each component is answering"). Rubric §"Components must
// be framed as answers to ground-problem questions, not as standalone
// parts" requires every wb-node naming a component to have a sibling
// wb-node-question text element.
//
// Detection: for every wb-node element, check that at least one
// text element exists with customData.nodeId === node.id and
// customData.fathomKind === 'wb-node-question'. If absent, FAIL.
//
// We DO NOT check the question's content here (e.g. that it terminates
// at the ground problem) — that's a semantic check the critic owns.
// This AC just asserts the structural slot is filled.
// ----------------------------------------------------------------------

function acComponentHasQuestion(elements: readonly ACElement[]): ACViolation[] {
  const out: ACViolation[] = [];
  const questionsByNodeId = new Set<string>();
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const cd = el.customData as { fathomKind?: string; nodeId?: string } | undefined;
    if (cd?.fathomKind !== 'wb-node-question') continue;
    if (typeof cd.nodeId !== 'string') continue;
    const text = (el.text ?? '').trim();
    if (text.length === 0) continue;
    questionsByNodeId.add(cd.nodeId);
  }
  for (const el of elements) {
    const cd = el.customData as { fathomKind?: string; nodeId?: string; kind?: string; role?: string } | undefined;
    if (cd?.fathomKind !== 'wb-node') continue;
    if (!el.id) continue;
    if (questionsByNodeId.has(el.id)) continue;
    // Future-proofing: agents may emit decorative endpoints (axis tick
    // labels, position-on-axis ellipses) as wb-node with role="neutral"
    // — those legitimately have no question. Skip role=neutral nodes.
    // If a future decorative shape needs another exemption, add it here
    // explicitly rather than weakening the predicate.
    if (cd.role === 'neutral') continue;
    const labelText =
      ((el as { label?: { text?: string } }).label?.text)?.split('\n')[0]?.trim() ?? (el.id ?? 'node');
    out.push({
      id: 'AC-COMPONENT-HAS-QUESTION',
      severity: 'FAIL',
      message:
        `Architecture node ${el.id} ("${labelText.slice(0, 50)}") has no wb-node-question subtitle. ` +
        `Per round-8 user critique: every architecture-named component must be paired with a visible "→ <question>" subtitle that traces back to the paper's ground problem. ` +
        `Pass the \`question\` parameter to create_node_with_fitted_text — the wrapper renders it. ` +
        `Verbatim: "when we are listing the modules or different components, it might help to understand things in a way that asks what is the answer that each component is answering."`,
      elementIds: [el.id],
    });
  }
  return out;
}
