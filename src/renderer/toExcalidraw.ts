/**
 * WBDiagram + ELK layout → Excalidraw scene elements.
 *
 * We never ask the LLM to emit Excalidraw JSON directly — Excalidraw
 * elements have ~30 fields each with brittle inter-element bindings
 * (a misnumbered `containerId` hides text inside a non-existent
 * container, a forgotten `boundElements` ref drops the arrow's link
 * to the source rect, etc.). LLMs get those consistently wrong.
 *
 * Instead we go DSL → ELK layout → ExcalidrawElementSkeleton[] →
 * `convertToExcalidrawElements`, which fills in the heavy details
 * and ensures inter-element refs are valid. CustomData carries every
 * piece of metadata we need at click-time (citation, drillable, etc.)
 * so the click handlers don't have to thread the WBDiagram through
 * separately. See spec §"Per-node metadata uses Excalidraw's
 * customData".
 *
 * Visual rules from `whiteboard-diagrams-research-visual-abstraction.md`:
 *   - Excalifont throughout (font family 5 in Excalidraw constants)
 *   - hand-drawn stroke style ("sketchy")
 *   - kind → palette: input=neutral, process=neutral, output=neutral,
 *     data=warm beige (#fff8ea), model=warm amber accent
 *   - novel/contribution box (kind=model OR explicit `novel:true`)
 *     gets stroke-width=2 for visual weight (Rohde — hierarchy via
 *     weight, not colour)
 *   - drillable nodes carry the dashed inner border + amber ⌖ glyph
 *     (rendered as a separate small text element below-right of the
 *     node's bounds; the *border* is the strokeStyle on the rect)
 *   - citation marker = small amber square in the node's top-right
 *     corner; verified=solid, unverified=dashed outline + faint `?`
 */

import type { WBDiagram, WBNode } from './dsl';
import type { LaidOutDiagram } from './elkLayout';
import { FIGURE_SLOT_WIDTH } from './elkLayout';

// --- Custom data shape we round-trip through Excalidraw's per-element
// `customData` map. Picks up at click time + on .excalidraw save.

export interface WBNodeCustomData {
  /** Marks this Excalidraw element as part of a Whiteboard frame so
   * stale handlers don't mistake user-drawn elements for nodes. The
   * `wb-skeleton` variant tags Doherty placeholder shapes so they can
   * be wholesale removed when the real Level 1 frame lands — the
   * regular `wb-node` tag is reused for both real and skeleton boxes
   * by Excalidraw's id rewrite, so we differentiate via this flag. */
  fathomKind:
    | 'wb-node'
    | 'wb-citation'
    | 'wb-drill-glyph'
    | 'wb-frame'
    | 'wb-edge'
    | 'wb-title'
    | 'wb-summary'
    | 'wb-figure'
    | 'wb-skeleton'
    /** Chat-as-diagram (2026-04-26): the orange-bordered Excalidraw
     * frame the chat agent emits as the container for one chat-turn's
     * answer. Sub-elements (chat-mode wb-node, wb-edge, etc.) carry
     * isChat=true + chatQueryId on their customData. */
    | 'wb-chat-frame';
  /** Chat elements only — true on every wb-* element a chat-mode MCP
   * call emitted, used by the L1 mount filter to preserve them across
   * re-mounts and by the renderer to apply the chat-frame stroke. */
  isChat?: boolean;
  /** Chat elements only — 8-char per-turn id mirrored from the chat
   * agent's getActiveFrameId(). Lets the renderer group elements by
   * turn (e.g. for "Clear this chat answer" affordances). */
  chatQueryId?: string;
  /** WBNode.id — the stable id within the diagram (e.g. "L1.2"). */
  nodeId?: string;
  /** Diagram level: 1 or 2. */
  level: 1 | 2;
  /** For Level 2 nodes, the parent's WBNode.id (e.g. "L1.2"). Lets a
   * click on a sub-node know which Level 1 node it lives under. */
  parentId?: string;
  /** Citation rolled up onto the same `customData` so the click
   * handler doesn't have to look it up by nodeId. */
  citation?: {
    page?: number;
    quote?: string;
    verified?: boolean;
    verifyScore?: number;
  };
  /** Drillable means the user can pinch / click into this node to
   * fetch its Level 2 expansion. */
  drillable?: boolean;
  /** ISO timestamp the node landed in the scene. Used for the "fresh"
   * glow animation on newly-rendered nodes. */
  generatedAt?: string;
}

/** Inputs needed to embed a paper figure inside a node. The renderer
 * reads the PNG via `asset:dataUrl`, registers it with Excalidraw's
 * `addFiles`, and generates an `image` skeleton bound to the resulting
 * fileId. The DSL's `figure_ref: {page, figure}` is resolved to a path
 * + fileId by `WhiteboardTab` before this builder runs. */
export interface WBFigureBinding {
  nodeId: string;
  fileId: string;
}

// Excalidraw constants — duplicated here because importing the
// constants module pulls in the full bundle, which breaks SSR-style
// builds. These values are stable across Excalidraw versions.
const FONT_FAMILY_EXCALIFONT = 5;
const FONT_FAMILY_HELVETICA = 1;

// Palette per spec — kind → fill + stroke. Kept neutral on purpose so
// the user's eye isn't pulled to a colour that means nothing in the
// paper. Amber is reserved for citation markers + drill glyphs (CLAUDE.md
// §2.3 — "amber is the marker colour", do not steal it for chrome).
function paletteFor(kind: WBNode['kind'] | undefined): { fill: string; stroke: string } {
  switch (kind) {
    case 'data':
      return { fill: '#fff8ea', stroke: '#1a1614' };
    case 'model':
      return { fill: '#fef4d8', stroke: '#9f661b' }; // warm amber accent
    case 'input':
    case 'output':
    case 'process':
    default:
      return { fill: '#ffffff', stroke: '#1a1614' };
  }
}

/**
 * Convert a laid-out WBDiagram into an array of ExcalidrawElement
 * skeletons. The caller pipes this into `convertToExcalidrawElements`.
 *
 * @param origin where in the scene to drop this diagram. Level 1 sits
 *   at the origin; Level 2 frames are positioned by the caller so they
 *   don't collide with the Level 1 frame.
 * @param figureBindings optional map nodeId → Excalidraw fileId for
 *   nodes whose `figure_ref` was successfully resolved to a paper PNG
 *   on disk. The renderer pre-registers the file via `addFiles` then
 *   passes us the fileId; we emit an image skeleton bound to it.
 */
export function diagramToSkeleton(
  diagram: WBDiagram,
  layout: LaidOutDiagram,
  origin: { x: number; y: number },
  figureBindings?: Map<string, string>,
): unknown[] {
  const elements: unknown[] = [];
  const generatedAt = new Date().toISOString();
  const nodeById = new Map(diagram.nodes.map((n) => [n.id, n]));
  // We use the *current* clock's milliseconds in id suffixes rather
  // than UUIDs because Excalidraw tolerates non-UUID ids (it tags
  // missing ones with its own internal ids). Stable enough for our
  // purposes; the canonical id in our data model is `customData.nodeId`.
  const stamp = Date.now().toString(36);

  // --- Optional title row at the top of the diagram.
  if (diagram.title) {
    elements.push({
      type: 'text',
      id: `wb-title-${stamp}`,
      x: origin.x,
      y: origin.y - 36,
      text: diagram.title,
      fontSize: 16,
      fontFamily: FONT_FAMILY_HELVETICA,
      strokeColor: '#1a1614',
      backgroundColor: 'transparent',
      customData: {
        fathomKind: 'wb-title',
        level: diagram.level,
      } as WBNodeCustomData,
    });
  }

  // --- Parent frame outline for Level 2 (visual continuity rule from
  //     the visual-abstraction researcher: parent's stroke + label
  //     persist as a soft frame around the L2 subgraph). Drawn first
  //     so nodes paint on top.
  if (diagram.level === 2 && diagram.parent) {
    const padX = 32;
    const padY = 56; // extra top room for the parent label
    elements.push({
      type: 'rectangle',
      id: `wb-frame-${stamp}`,
      x: origin.x - padX,
      y: origin.y - padY,
      width: layout.width + padX * 2,
      height: layout.height + padY + padX,
      strokeColor: '#9f661b',
      backgroundColor: 'transparent',
      strokeWidth: 1,
      strokeStyle: 'dashed',
      roundness: { type: 3 },
      roughness: 1,
      customData: {
        fathomKind: 'wb-frame',
        level: diagram.level,
        parentId: diagram.parent,
      } as WBNodeCustomData,
    });
    elements.push({
      type: 'text',
      id: `wb-frame-label-${stamp}`,
      x: origin.x - padX + 12,
      y: origin.y - padY + 8,
      text: diagram.parent ?? '',
      fontSize: 12,
      fontFamily: FONT_FAMILY_HELVETICA,
      strokeColor: '#9f661b',
      customData: {
        fathomKind: 'wb-title',
        level: diagram.level,
        parentId: diagram.parent,
      } as WBNodeCustomData,
    });
  }

  // --- Nodes. Each node is a rectangle bound to one text element
  //     containing label + (optional) summary on separate lines. We do
  //     NOT free-position summary text — Excalidraw's `containerId`
  //     binding centers and word-wraps the text inside the container,
  //     which is the only positioning the v1 attempt got wrong (text
  //     spilled outside the rect because it lived in scene coords, not
  //     container-relative coords). Citation marker, drill glyph, and
  //     embedded figure are positioned absolutely in scene coords —
  //     they're *outside* the bound text and live above the rect.
  for (const laidOut of layout.nodes) {
    const node = nodeById.get(laidOut.id);
    if (!node) continue;
    const palette = paletteFor(node.kind);
    const isModelKind = node.kind === 'model';
    const rectId = `wb-node-${node.id}-${stamp}`;
    const fileId = figureBindings?.get(node.id);
    // When a figure is embedded, the ELK layout reserved an extra
    // FIGURE_SLOT_WIDTH px on top of the base node width. We render
    // the rectangle at the *base* width and place the figure in the
    // gutter to the right; without this split the figure would overlap
    // the rectangle, defeating the "side-by-side" embedding.
    const rectWidth = fileId ? laidOut.width - FIGURE_SLOT_WIDTH : laidOut.width;

    // Compose the bound text content. Label on line 1; if a summary is
    // present we drop it on a new line in a smaller cognitive register
    // (Excalidraw can't change font-size mid-text on a bound element,
    // so we use a single font and let the wrap rules handle it).
    // Summary is pre-truncated by the DSL parser to ≤30 words; we
    // also hard-cap at ~120 chars here so a 30-word run of long words
    // can't blow out a 160px-wide rectangle.
    const safeSummary =
      node.summary && node.summary.length > 0
        ? node.summary.length > 110
          ? node.summary.slice(0, 109) + '…'
          : node.summary
        : '';
    const boundText = safeSummary ? `${node.label}\n${safeSummary}` : node.label;

    // Main rectangle. boundElements is auto-populated by
    // convertToExcalidrawElements once it sees a text with this
    // containerId.
    elements.push({
      type: 'rectangle',
      id: rectId,
      x: origin.x + laidOut.x,
      y: origin.y + laidOut.y,
      width: rectWidth,
      height: laidOut.height,
      strokeColor: palette.stroke,
      backgroundColor: palette.fill,
      strokeWidth: isModelKind ? 2 : 1,
      strokeStyle: node.drillable ? 'dashed' : 'solid',
      // 3 = sharp, 2 = round; ROUNDNESS = { LEGACY: 1,
      // PROPORTIONAL_RADIUS: 2, ADAPTIVE_RADIUS: 3 }. Adaptive feels
      // closest to "casual hand-drawn rounded rect".
      roundness: { type: 3 },
      roughness: 1,
      fillStyle: 'solid',
      customData: {
        fathomKind: 'wb-node',
        nodeId: node.id,
        level: diagram.level,
        parentId: diagram.parent,
        citation: node.citation,
        drillable: node.drillable,
        generatedAt,
      } as WBNodeCustomData,
    });

    // ONE bound text element — Excalidraw centers + wraps it inside
    // the parent rectangle. No manual x/y arithmetic, no risk of
    // spilling outside the container. We omit `x`/`y` entirely so
    // Excalidraw places the text at the container's center; setting
    // `containerId` makes it a child of the rectangle.
    elements.push({
      type: 'text',
      text: boundText,
      x: origin.x + laidOut.x,
      y: origin.y + laidOut.y,
      fontSize: safeSummary ? 13 : 16,
      fontFamily: FONT_FAMILY_EXCALIFONT,
      textAlign: 'center',
      verticalAlign: 'middle',
      strokeColor: '#1a1614',
      // Bind to container so Excalidraw centers the text *inside* the
      // rectangle's bounding box and word-wraps on container width.
      containerId: rectId,
      customData: {
        fathomKind: safeSummary ? 'wb-summary' : 'wb-node',
        nodeId: node.id,
        level: diagram.level,
      } as WBNodeCustomData,
    });

    // Embedded paper figure — positioned to the right of the
    // rectangle so it doesn't fight the bound text for space inside.
    // Caller is responsible for sizing the layout's `figureSlotWidth`
    // (see elkLayout.ts) so the figure lands in the gutter rather
    // than overlapping a sibling node.
    if (fileId) {
      const figW = 100;
      const figH = Math.min(laidOut.height, 100);
      elements.push({
        type: 'image',
        fileId: fileId as unknown as never,
        x: origin.x + laidOut.x + rectWidth + 8,
        y: origin.y + laidOut.y + (laidOut.height - figH) / 2,
        width: figW,
        height: figH,
        // status: 'saved' tells Excalidraw the file is already in its
        // BinaryFiles store (we addFiles'd it before mounting).
        status: 'saved',
        customData: {
          fathomKind: 'wb-figure',
          nodeId: node.id,
          level: diagram.level,
        } as WBNodeCustomData,
      });
    }

    // Citation marker — small amber square in the node's top-right.
    // Two-channel verified/unverified affordance: solid for verified,
    // dashed outline + faint ? glyph for unverified. Sits ABOVE the
    // rectangle's stroke (3 px overhang) so it reads as a sticky
    // tag rather than crowding the bound text below.
    if (node.citation) {
      const verified = node.citation.verified !== false;
      const cx = origin.x + laidOut.x + rectWidth - 14;
      const cy = origin.y + laidOut.y - 6;
      elements.push({
        type: 'rectangle',
        id: `wb-citation-${node.id}-${stamp}`,
        x: cx,
        y: cy,
        width: 10,
        height: 10,
        strokeColor: '#9f661b',
        backgroundColor: verified ? '#9f661b' : 'transparent',
        strokeWidth: 1,
        strokeStyle: verified ? 'solid' : 'dashed',
        roundness: null,
        fillStyle: 'solid',
        customData: {
          fathomKind: 'wb-citation',
          nodeId: node.id,
          level: diagram.level,
          citation: node.citation,
        } as WBNodeCustomData,
      });
      if (!verified) {
        elements.push({
          type: 'text',
          id: `wb-citation-q-${node.id}-${stamp}`,
          x: cx + 2,
          y: cy - 2,
          text: '?',
          fontSize: 9,
          fontFamily: FONT_FAMILY_HELVETICA,
          strokeColor: '#9f661b',
          customData: {
            fathomKind: 'wb-citation',
            nodeId: node.id,
            level: diagram.level,
          } as WBNodeCustomData,
        });
      }
    }

    // Drill glyph — small ⌖ INSIDE the bottom-right of drillable
    // nodes (3 px in from each edge). Sitting outside the rectangle
    // (v1) read as "stray punctuation" to the visual critic; inside
    // it reads as "this is the affordance". The rect is sized with
    // headroom (NODE_INNER_PAD_Y) so the glyph never collides with
    // the bound label text.
    if (node.drillable) {
      elements.push({
        type: 'text',
        id: `wb-drill-${node.id}-${stamp}`,
        x: origin.x + laidOut.x + rectWidth - 16,
        y: origin.y + laidOut.y + laidOut.height - 18,
        text: '⌖',
        fontSize: 14,
        fontFamily: FONT_FAMILY_HELVETICA,
        strokeColor: '#9f661b',
        opacity: 80,
        customData: {
          fathomKind: 'wb-drill-glyph',
          nodeId: node.id,
          level: diagram.level,
          drillable: true,
        } as WBNodeCustomData,
      });
    }
  }

  // --- Edges. ELK already routed every edge through `points[]` —
  //     start, optional bend points, end — that DO NOT cross any node
  //     because we asked for `elk.edgeRouting=ORTHOGONAL`. We feed
  //     these polylines directly into the Excalidraw arrow's `points`
  //     array. v1 used a single straight segment (`[[0,0],[dx,dy]]`)
  //     which Excalidraw drew as a diagonal that often passed THROUGH
  //     a sibling node; the routed polyline avoids that.
  diagram.edges.forEach((edge, i) => {
    const startRect = `wb-node-${edge.from}-${stamp}`;
    const endRect = `wb-node-${edge.to}-${stamp}`;
    const fromLO = layout.nodes.find((n) => n.id === edge.from);
    const toLO = layout.nodes.find((n) => n.id === edge.to);
    if (!fromLO || !toLO) return;
    // Find the matching laid-out edge (ELK gives us one polyline per
    // input edge, in input order). If ELK didn't return points (rare —
    // happens if the layered algorithm dropped a self-loop), fall
    // back to the straight from-edge-mid-right → to-edge-mid-left
    // segment we used in v1.
    const layoutEdge = layout.edges[i];
    let arrowOriginX: number;
    let arrowOriginY: number;
    let relativePoints: Array<[number, number]>;
    if (layoutEdge && layoutEdge.points.length >= 2) {
      // ELK polyline is in scene coords *relative to the layout's
      // top-left*. Add `origin` to translate into our diagram's scene
      // coords. The Excalidraw arrow's `x`/`y` is the FIRST point,
      // and `points` are offsets relative to that origin.
      const [first, ...rest] = layoutEdge.points;
      arrowOriginX = origin.x + first.x;
      arrowOriginY = origin.y + first.y;
      relativePoints = [
        [0, 0],
        ...rest.map((p): [number, number] => [
          origin.x + p.x - arrowOriginX,
          origin.y + p.y - arrowOriginY,
        ]),
      ];
    } else {
      arrowOriginX = origin.x + fromLO.x + fromLO.width;
      arrowOriginY = origin.y + fromLO.y + fromLO.height / 2;
      const endX = origin.x + toLO.x;
      const endY = origin.y + toLO.y + toLO.height / 2;
      relativePoints = [
        [0, 0],
        [endX - arrowOriginX, endY - arrowOriginY],
      ];
    }
    elements.push({
      type: 'arrow',
      id: `wb-edge-${i}-${stamp}`,
      x: arrowOriginX,
      y: arrowOriginY,
      points: relativePoints,
      strokeColor: '#1a1614',
      strokeWidth: 1.2,
      roughness: 1,
      start: { id: startRect, type: 'rectangle' },
      end: { id: endRect, type: 'rectangle' },
      label: edge.label
        ? {
            text: edge.label,
            fontSize: 11,
            fontFamily: FONT_FAMILY_HELVETICA,
            strokeColor: '#5a4a3a',
          }
        : undefined,
      customData: {
        fathomKind: 'wb-edge',
        level: diagram.level,
        parentId: diagram.parent,
      } as WBNodeCustomData,
    });
  });

  return elements;
}

/** Compute a bounding box (in scene coords) for the laid-out diagram
 * including the parent frame for Level 2. The whiteboard tab uses
 * this to call `scrollToContent` and animate-zoom into the diagram on
 * drill-in. */
export function diagramBoundingBox(
  diagram: WBDiagram,
  layout: LaidOutDiagram,
  origin: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  if (diagram.level === 2) {
    const padX = 32;
    const padY = 56;
    return {
      x: origin.x - padX,
      y: origin.y - padY,
      width: layout.width + padX * 2,
      height: layout.height + padY + padX,
    };
  }
  return {
    x: origin.x,
    y: origin.y,
    width: layout.width,
    height: layout.height,
  };
}
