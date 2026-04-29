/**
 * WBDiagram DSL — the loose JSON schema Pass 2 of the Whiteboard
 * pipeline emits. Spec: `.claude/specs/whiteboard-diagrams.md` §"Pass 2".
 *
 * Per the user's "rigorous structures can often be counterproductive"
 * direction, the parser here is deliberately tolerant:
 *   - missing fields default
 *   - unknown `kind` values fall back to "process"
 *   - layout-hint defaults to "lr"
 *   - extra unknown fields are ignored
 *   - a string can be the *whole* output and we'll try to find the
 *     diagram inside ```json …``` fences.
 *
 * Contract: as long as the model emits at least one node and one
 * edge, we render *something*. Bad output is a soft failure with a
 * banner — never a crash.
 */

export type WBKind = 'input' | 'process' | 'output' | 'data' | 'model';

export interface WBCitation {
  /** 1-based page number in the paper. */
  page?: number;
  /** Verbatim quote pulled from the paper. The soft-verifier checks
   * trigram overlap against `content.md`; a low overlap score sets
   * `verified=false` so the renderer can show the dashed-outline marker. */
  quote?: string;
  /** Filled in by the renderer after the verifier runs. NOT a model output. */
  verified?: boolean;
  /** Trigram overlap score (0..1) against the closest passage in
   * content.md. Filled in by the verifier; renderer shows it on hover. */
  verifyScore?: number;
}

export interface WBFigureRef {
  /** 1-based page number the figure lives on. */
  page: number;
  /** 1-based figure index within the page (matches the
   * `images/page-NNN-fig-K.png` naming convention from the indexer). */
  figure: number;
}

export interface WBNode {
  /** Stable id within the diagram. Format hint: "L1.1", "L1.2.3" so a
   * Level 2 node knows its parent ("L1.2") for click-to-zoom-out. */
  id: string;
  label: string;
  kind?: WBKind;
  /** ≤ 25 words of inline subtitle. Optional — many leaf nodes don't
   * need one. */
  summary?: string;
  /** True iff this node has a Level 2 expansion the user can drill into.
   * Renders the dashed inner border + ⌖ glyph. */
  drillable?: boolean;
  citation?: WBCitation;
  /** Optional figure reference. When set, the renderer embeds the
   * cropped PNG from `<sidecarDir>/images/page-NNN-fig-K.png` next to
   * the node's text — readers recognise their own paper's figures
   * instantly. Pass 2 is instructed to set this when the understanding
   * doc names a figure for a node. Falls back silently if the file
   * doesn't exist on disk. */
  figure_ref?: WBFigureRef;
}

export interface WBEdge {
  from: string;
  to: string;
  /** Optional edge label (e.g. tensor shape, "× 6 stack"). */
  label?: string;
}

export type WBLayoutHint = 'lr' | 'tb';

export interface WBDiagram {
  level: 1 | 2;
  /** Title that renders at the top of the frame. Optional. */
  title?: string;
  /** Present on Level 2 only — id of the Level 1 node this is the
   * interior of. Used to draw the parent-frame outline + label. */
  parent?: string;
  nodes: WBNode[];
  edges: WBEdge[];
  layout_hint?: WBLayoutHint;
}

const KNOWN_KINDS: WBKind[] = ['input', 'process', 'output', 'data', 'model'];

/**
 * Parse a Pass 2 raw response into a WBDiagram. Tolerant to:
 *   - leading / trailing prose
 *   - ```json fences
 *   - ``` plain fences
 *   - bare JSON objects with no fence
 *   - extra fields
 *   - missing optional fields
 *   - kind values outside the union
 *   - layout hints outside {lr, tb}
 *
 * Returns null if no parseable JSON object can be located OR if the
 * resulting object has zero usable nodes. The renderer treats null as
 * "show the error state with a retry button" — never crashes.
 */
export function parseWBDiagram(
  raw: string,
  request: { level: 1 | 2; parent?: string },
): WBDiagram | null {
  const obj = extractFirstJsonObject(raw);
  if (!obj) return null;

  const nodesRaw: unknown[] = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edgesRaw: unknown[] = Array.isArray(obj.edges) ? obj.edges : [];

  const nodes: WBNode[] = [];
  for (const n of nodesRaw) {
    const node = coerceNode(n);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return null;

  // Allow at most 5 nodes per diagram (Cowan 4±1; cog reviewer hard
  // ceiling). If the model emits more, we keep the first 5 and log —
  // letting it through would silently violate a CLAUDE.md principle.
  const trimmedNodes = nodes.slice(0, 5);
  const trimmedIds = new Set(trimmedNodes.map((n) => n.id));

  const edges: WBEdge[] = [];
  for (const e of edgesRaw) {
    const edge = coerceEdge(e);
    if (!edge) continue;
    // Drop edges whose endpoints we trimmed away — would render as
    // dangling arrows.
    if (!trimmedIds.has(edge.from) || !trimmedIds.has(edge.to)) continue;
    edges.push(edge);
  }

  const titleVal = obj.title;
  const layoutVal = obj.layout_hint;
  const parentVal = obj.parent;

  return {
    level: request.level,
    title: typeof titleVal === 'string' && titleVal.length > 0 ? titleVal : undefined,
    parent:
      request.level === 2
        ? typeof parentVal === 'string' && parentVal.length > 0
          ? parentVal
          : request.parent
        : undefined,
    nodes: trimmedNodes,
    edges,
    layout_hint: layoutVal === 'tb' ? 'tb' : 'lr',
  };
}

function coerceNode(n: unknown): WBNode | null {
  if (!n || typeof n !== 'object') return null;
  const o = n as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  const label = typeof o.label === 'string' ? o.label.trim() : null;
  if (!id || !label) return null;
  const kindCandidate = o.kind;
  const kind: WBKind =
    typeof kindCandidate === 'string' && (KNOWN_KINDS as string[]).includes(kindCandidate)
      ? (kindCandidate as WBKind)
      : 'process';
  const summary =
    typeof o.summary === 'string' && o.summary.trim().length > 0
      ? truncateWords(o.summary.trim(), 30)
      : undefined;
  const drillable = o.drillable === true;
  const citation = coerceCitation(o.citation);
  const figure_ref = coerceFigureRef(o.figure_ref);
  // Hard length cap on the label. Cog reviewer veto is "≤ 24 chars".
  // We honour it strictly because the rect's text-aware sizing has a
  // NODE_MAX_WIDTH ceiling at 320 px outer / 292 px inner — at
  // 16 px Excalifont (~9-10 px/char), a 24-char label is the largest
  // that fits on one line inside that ceiling. Allowing 28 chars
  // (the previous value) caused stress-test labels like "Tokenization
  // & Positional Encoding" (35 chars truncated to 28) to overflow,
  // since 28×9.5 = ~266 px exceeds the inner width once Excalifont's
  // wider-than-system-sans metrics kick in. Caught by the render-only
  // CLI 2026-04-26.
  const safeLabel = label.length > 24 ? label.slice(0, 23) + '…' : label;
  return {
    id,
    label: safeLabel,
    kind,
    summary,
    drillable,
    citation,
    figure_ref,
  };
}

function coerceFigureRef(f: unknown): WBFigureRef | undefined {
  if (!f || typeof f !== 'object') return undefined;
  const o = f as Record<string, unknown>;
  const page =
    typeof o.page === 'number' && Number.isFinite(o.page) && o.page > 0
      ? Math.round(o.page)
      : undefined;
  const figure =
    typeof o.figure === 'number' && Number.isFinite(o.figure) && o.figure > 0
      ? Math.round(o.figure)
      : undefined;
  if (page === undefined || figure === undefined) return undefined;
  return { page, figure };
}

function coerceEdge(e: unknown): WBEdge | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const from = typeof o.from === 'string' ? o.from : null;
  const to = typeof o.to === 'string' ? o.to : null;
  if (!from || !to) return null;
  const labelRaw = typeof o.label === 'string' ? o.label.trim() : '';
  const label = labelRaw.length > 0 ? labelRaw.slice(0, 24) : undefined;
  return { from, to, label };
}

function coerceCitation(c: unknown): WBCitation | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Record<string, unknown>;
  const page =
    typeof o.page === 'number' && Number.isFinite(o.page) && o.page > 0
      ? Math.round(o.page)
      : undefined;
  const quote =
    typeof o.quote === 'string' && o.quote.trim().length > 0 ? o.quote.trim() : undefined;
  if (page === undefined && quote === undefined) return undefined;
  return { page, quote };
}

function truncateWords(s: string, maxWords: number): string {
  const parts = s.split(/\s+/);
  if (parts.length <= maxWords) return s;
  return parts.slice(0, maxWords).join(' ') + '…';
}

/** Pull the first JSON object out of `raw` — handles ```json fences,
 * ``` plain fences, or bare JSON. Returns null on nothing parseable. */
function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  // Try fenced ```json first.
  const jsonFence = /```json\s*([\s\S]*?)```/i.exec(raw);
  if (jsonFence) {
    const parsed = safeParse(jsonFence[1]);
    if (parsed) return parsed;
  }
  // Fall back to any ``` fence.
  const anyFence = /```[\w-]*\s*([\s\S]*?)```/.exec(raw);
  if (anyFence) {
    const parsed = safeParse(anyFence[1]);
    if (parsed) return parsed;
  }
  // Bare object — find the first '{' and the matching '}'.
  const start = raw.indexOf('{');
  if (start < 0) return null;
  // Scan forward counting braces so a nested object doesn't terminate
  // us early. Tracks string state so a brace inside a string literal
  // doesn't count.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        const parsed = safeParse(slice);
        if (parsed) return parsed;
        return null;
      }
    }
  }
  return null;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON — caller falls through */
  }
  return null;
}
