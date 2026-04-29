/**
 * ELK.js auto-layout for WBDiagrams. The model emits nodes + edges
 * with no positions; we feed them into Eclipse Layout Kernel for
 * deterministic, hierarchical placement, then return the laid-out
 * coordinates the Excalidraw scene needs.
 *
 * Why ELK and not dagre / cytoscape:
 * - ELK ships a ready-built worker bundle (`elkjs/lib/elk-worker.min.js`)
 *   so layout runs off the renderer's main thread — important since
 *   we may run ≥6 layouts back-to-back during the Level 1 + Level 2
 *   hydration burst.
 * - The "layered" algorithm is the canonical Sugiyama for left-right
 *   pipelines, which is exactly what every Level 1 looks like
 *   (input → process → output).
 * - The same engine Excalidraw's own Mermaid-import path uses, so the
 *   visual rhythm matches what users have already seen elsewhere.
 *
 * Layout choices intentionally left simple — the ≤5 node ceiling
 * means pathological layouts can't happen. If a future Level 3 ever
 * lands and needs richer routing, this is the file to revisit.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ELK as ElkInstanceType } from 'elkjs/lib/elk-api';
import type { WBDiagram, WBLayoutHint, WBNode } from './dsl';
import {
  fitNodeSize as sharedFitNodeSize,
  type FitNodeDims,
  type TextMeasurer,
} from '../shared/whiteboard-text-fit';

// One ELK instance reused across calls. Lazily constructed on first
// layout — Electron's main thread keeps the Worker alive between
// renders, which avoids a ~50 ms startup cost on every drill-in.
let elkInstance: ElkInstanceType | null = null;
function elk(): ElkInstanceType {
  if (elkInstance) return elkInstance;
  // Use the bundled (no-worker) build so we don't fight Electron's
  // sandboxing of Worker URLs in the renderer. The bundle is small
  // (~600 KB) and runs synchronously enough for our ≤5-node layouts.
  elkInstance = new ELK();
  return elkInstance;
}

/** Hard floor on node dimensions — even an empty label gets at least
 * this much space so the diagram has visual rhythm at small node
 * counts. The actual width grows from here based on measured text. */
const NODE_MIN_WIDTH = 180;
const NODE_MIN_HEIGHT = 80;
/** Hard ceiling — beyond this we wrap onto more lines rather than
 * keep growing the rectangle. Past 320 px a node starts to feel like
 * a paragraph rather than a label, breaking the diagram-density
 * invariant (≤4-fixation read per node, cog reviewer §4). */
const NODE_MAX_WIDTH = 320;
/** Per-side internal padding inside the rectangle. Bound text from
 * Excalidraw wraps inside `rect.width - 2*PAD`, so this MUST match
 * what Excalidraw actually allows for the bound text element or our
 * pre-measurement diverges from the renderer's wrap behaviour. */
const NODE_INNER_PAD_X = 14;
const NODE_INNER_PAD_Y = 14;
/** Font sizes. Mirrors what `toExcalidraw.ts` writes to the bound
 * text element (`fontSize: safeSummary ? 13 : 16`). Keep in sync. */
const LABEL_FONT_SIZE = 16;
const SUMMARY_FONT_SIZE = 13;
// `LINE_HEIGHT_RATIO` is now imported from
// `src/shared/whiteboard-text-fit.ts` (Dedup B / #71) — the renderer's
// previous local value (1.25) has been consolidated to the MCP value
// (1.3); this widens nodes' computed height by ~3% to match what MCP
// already told the agent at authoring time.
/** Extra horizontal slot for an embedded paper figure. The figure
 * itself is ~100 px wide; the spacing keeps it from kissing the next
 * column when ELK lays nodes out left-to-right. Exported so
 * toExcalidraw.ts can split a figure-bearing layout box back into
 * "rectangle width" + "figure gutter" with the same constant. */
export const FIGURE_SLOT_WIDTH = 120;
const SPACING_NODE_NODE = 100;
const SPACING_LAYER = 120;

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  /** Polyline points (x,y pairs) including start + end. Empty edges
   * use a straight line from source-center to target-center, drawn by
   * the Excalidraw arrow element directly. */
  points: Array<{ x: number; y: number }>;
}

export interface LaidOutDiagram {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

/**
 * Run ELK on a WBDiagram. Returns positions in CSS pixels relative to
 * the diagram's top-left.
 */
export async function layoutDiagram(d: WBDiagram): Promise<LaidOutDiagram> {
  const direction = elkDirection(d.layout_hint);
  const t0 = performance.now();

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': String(SPACING_NODE_NODE),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(SPACING_LAYER),
      // Wider edge-to-node spacing so routed orthogonal arrows have
      // room to bend AROUND nodes instead of grazing or crossing them.
      // v1 used '24' which left orthogonal segments visually touching
      // adjacent rectangles when 5 nodes were dense.
      'elk.layered.spacing.edgeNodeBetweenLayers': '40',
      'elk.spacing.edgeNode': '32',
      'elk.spacing.edgeEdge': '20',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      // ORTHOGONAL routing produces axis-aligned bend points that
      // never cross node geometry (so long as edge-node spacing is
      // wide enough). The renderer must feed `LaidOutEdge.points`
      // into the Excalidraw arrow's `points` array — see
      // toExcalidraw.ts. Without that, Excalidraw re-routes diagonally
      // and the cross-through bug returns.
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: d.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      // Add the figure gutter to the layout width when a figure is
      // embedded — keeps figures inside the slot ELK reserves for the
      // node, not overlapping the next sibling.
      const totalW = n.figure_ref ? w + FIGURE_SLOT_WIDTH : w;
      return { id: n.id, width: totalW, height: h };
    }),
    edges: d.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  let result: ElkNode;
  try {
    result = await elk().layout(graph);
  } catch (err) {
    // Fall back to a deterministic horizontal layout if ELK throws —
    // better than a blank canvas. Errors here are rare (we control
    // the input shape) but never let them break the user's flow.
    console.warn('[Whiteboard Render] ELK layout failed; using fallback line layout', err);
    return fallbackLineLayout(d);
  }

  const nodes: LaidOutNode[] = (result.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? NODE_MIN_WIDTH,
    height: c.height ?? NODE_MIN_HEIGHT,
  }));

  const edges: LaidOutEdge[] = [];
  // ELK puts edges as `result.edges` (since we gave them at root).
  type ElkRootEdge = { sources?: string[]; targets?: string[]; sections?: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }> };
  const rawEdges = ((result as unknown as { edges?: ElkRootEdge[] }).edges ?? []) as ElkRootEdge[];
  for (const re of rawEdges) {
    const from = re.sources?.[0];
    const to = re.targets?.[0];
    if (!from || !to) continue;
    const section = re.sections?.[0];
    const points: Array<{ x: number; y: number }> = [];
    if (section) {
      points.push({ x: section.startPoint.x, y: section.startPoint.y });
      for (const bp of section.bendPoints ?? []) points.push({ x: bp.x, y: bp.y });
      points.push({ x: section.endPoint.x, y: section.endPoint.y });
    }
    edges.push({ from, to, points });
  }

  // Compute overall bounds so the caller can size the parent frame.
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  const width = result.width ?? Math.max(maxX, NODE_MIN_WIDTH);
  const height = result.height ?? Math.max(maxY, NODE_MIN_HEIGHT);

  console.log(
    `[Whiteboard Render] ELK layout: ${nodes.length} nodes, ${edges.length} edges, ` +
      `${Math.round(width)}×${Math.round(height)}, t=${Math.round(performance.now() - t0)}ms`,
  );

  return { width, height, nodes, edges };
}

function elkDirection(hint: WBLayoutHint | undefined): string {
  return hint === 'tb' ? 'DOWN' : 'RIGHT';
}

/** Lazy Canvas 2D context for text measurement. Created off-screen
 * the first time a node is sized; reused across all subsequent
 * measurements in the session. Free under the renderer's GC pressure. */
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null; // SSR / non-DOM
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  measureCtx = ctx;
  return ctx;
}

/** Measure the rendered width of `text` at `fontSize` in
 * Excalifont/Helvetica. Falls back to a chars × 0.55 * fontSize
 * estimate when the canvas context is unavailable. */
function measureTextWidth(text: string, fontSize: number, family: string): number {
  const ctx = getMeasureContext();
  if (!ctx) return text.length * fontSize * 0.55;
  ctx.font = `${fontSize}px ${family}, system-ui, sans-serif`;
  return ctx.measureText(text).width;
}

/** Compute the box dimensions for a node sized to GUARANTEE its
 * `label` + `summary` text fits inside without overflow at the
 * rendered font size. The renderer in `toExcalidraw.ts` writes a
 * single bound text element with `fontSize: safeSummary ? 13 : 16`
 * and a `\n` between label and summary; we reproduce that wrapping
 * here against a Canvas 2D context so the rectangle dimensions are
 * known to the LLM/critique loop and to Excalidraw's containerId
 * binding before render time.
 *
 * Delegates to `sharedFitNodeSize` (Dedup B / #71); the renderer's
 * Canvas-2D `measureTextWidth` is passed as the `measure` callback so
 * the shared algorithm uses real font measurement. Char-width fields
 * on `FitNodeDims` are required by the shape but ignored when
 * `measure` is supplied.
 *
 * Returns `{ w, h }` in CSS pixels. Caller is responsible for adding
 * FIGURE_SLOT_WIDTH separately when a figure is embedded. */
export function nodeSize(node: Pick<WBNode, 'label' | 'summary' | 'figure_ref'>): { w: number; h: number } {
  const labelFamily = "'Excalifont', 'Caveat', 'Kalam', 'Bradley Hand', cursive";
  const summaryFamily = "'Helvetica', system-ui, sans-serif";
  const summary = node.summary?.trim() ?? '';
  const label = node.label?.trim() ?? '';

  const dims: FitNodeDims = {
    NODE_MIN_WIDTH,
    NODE_MAX_WIDTH,
    NODE_MIN_HEIGHT,
    NODE_INNER_PAD_X,
    NODE_INNER_PAD_Y,
    LABEL_FONT: LABEL_FONT_SIZE,
    SUMMARY_FONT: SUMMARY_FONT_SIZE,
    LABEL_CHAR_W: 0, // ignored — measure callback supplied
    SUMMARY_CHAR_W: 0, // ignored — measure callback supplied
    LABEL_FAMILY: labelFamily,
    SUMMARY_FAMILY: summaryFamily,
  };
  const measure: TextMeasurer = (text, fontSize, family) =>
    measureTextWidth(text, fontSize, family);

  const { w, h } = sharedFitNodeSize(label, summary, dims, measure);
  return { w, h };
}

/** Deterministic horizontal layout used when ELK throws. Stacks nodes
 * left-to-right with simple spacing. Edges become straight lines
 * (rendered by Excalidraw with their own routing). */
function fallbackLineLayout(d: WBDiagram): LaidOutDiagram {
  const nodes: LaidOutNode[] = [];
  let x = 0;
  let maxH = NODE_MIN_HEIGHT;
  for (const n of d.nodes) {
    const { w, h } = nodeSize(n);
    const totalW = n.figure_ref ? w + FIGURE_SLOT_WIDTH : w;
    nodes.push({ id: n.id, x, y: 0, width: totalW, height: h });
    x += totalW + SPACING_NODE_NODE;
    if (h > maxH) maxH = h;
  }
  const width = Math.max(0, x - SPACING_NODE_NODE);
  const height = maxH;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: LaidOutEdge[] = d.edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return { from: e.from, to: e.to, points: [] };
    return {
      from: e.from,
      to: e.to,
      points: [
        { x: a.x + a.width, y: a.y + a.height / 2 },
        { x: b.x, y: b.y + b.height / 2 },
      ],
    };
  });
  return { width, height, nodes, edges };
}
