/**
 * Whiteboard SDK MCP — Pass 2 agent's tool surface for authoring
 * Excalidraw scenes directly.
 *
 * Architecture choice: Option C (per .claude/specs/whiteboard-mcp-pivot.md
 * and the team-lead's 2026-04-26 ratification). We do NOT spawn the
 * upstream `yctimlin/mcp_excalidraw` Express+stdio pair — that's
 * designed for chat clients with a live shared canvas, which Fathom
 * doesn't need. Instead we build a single SDK MCP via
 * `createSdkMcpServer` that owns an in-memory scene state and exposes
 * the same tool taxonomy (create + connect + describe + export +
 * read_diagram_guide) the upstream provides. State is per-call by
 * construction; no port management; no zombie cleanup.
 *
 * Six tools:
 *   - read_diagram_guide  — returns Fathom's spec rules so the agent
 *     knows the bar (≤5 nodes, horizontal pipeline, drillable=⌖+dashed,
 *     citations as amber squares, palette by kind).
 *   - create_node_with_fitted_text — load-bearing piece. Measures
 *     label+summary server-side using the same char-width approximation
 *     the render-only CLI uses (proven in earlier rounds), sizes the
 *     rect to fit, emits rect + bound-text into in-memory state.
 *     Returns the rect's id so the agent can chain into `connect_nodes`.
 *   - connect_nodes — emits an arrow with proper start/end bindings so
 *     it tracks node movement (in case the agent moves nodes around).
 *   - describe_scene — text dump of the in-memory state. Counts by
 *     element kind, positions, broken-binding check, overflow check.
 *     The agent's self-critique loop runs through this.
 *   - export_scene — finalises the .excalidraw JSON the renderer
 *     loads. Caller writes to <sidecar>/whiteboard.excalidraw.
 *   - clear_scene — wipes in-memory state. Used at the start of each
 *     call (the SDK MCP is per-call but defensive).
 *
 * The output of export_scene is the SAME .excalidraw shape the renderer
 * already understands. No translation layer between Pass 2 and the
 * renderer — single source of truth.
 *
 * Text measurement: uses character-width approximation matching the
 * render-only CLI (10 px/char @ 16 px Excalifont label, 7.5 px/char
 * @ 13 px Helvetica summary). This is intentionally OVER-estimated so
 * the rect always fits — Excalidraw's actual rendering may be
 * slightly tighter, leaving a few px of slack inside the box. No
 * `node-canvas` dep needed.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCritique } from '../whiteboard-critique';
import {
  getTemplate,
  loadCatalog,
  annotateCatalog,
  registeredTemplateIds,
  translateElements,
  stampTemplate,
} from './templates';
import {
  wrapToWidth,
  LINE_HEIGHT_RATIO,
} from '../../shared/whiteboard-text-fit';
import {
  ROLES,
  KINDS,
  rolePalette,
  defaultRoleForKind,
  type Role,
  type Kind,
} from '../../shared/whiteboard-palette';

// --- Element shape constants. These mirror `toExcalidraw.ts`'s
//     palette + sizing constants. Kept self-contained so this module
//     has zero dependency on the renderer (no React, no DOM, just
//     pure scene-element synthesis).

const FONT_FAMILY_EXCALIFONT = 5;
const FONT_FAMILY_HELVETICA = 1;

const LABEL_FONT = 16;
const SUMMARY_FONT = 13;
const LABEL_CHAR_W = 10;
const SUMMARY_CHAR_W = 7.5;

const NODE_MIN_WIDTH = 180;
const NODE_MIN_HEIGHT = 80;
const NODE_MAX_WIDTH = 320;
const NODE_INNER_PAD_X = 14;
const NODE_INNER_PAD_Y = 14;

// `Kind`, `Role`, `rolePalette`, `defaultRoleForKind`, `LINE_HEIGHT_RATIO`,
// `wrapToWidth`, and `fitNodeSize` are now imported from
// `src/shared/whiteboard-text-fit.ts` and `src/shared/whiteboard-palette.ts`
// (Dedup B / #71). The MCP-local `paletteFor` below is intentionally not
// lifted — it's byte-for-byte identical to the renderer's copy and consolidating
// would be cosmetic; defer to a future API redesign.

function paletteFor(kind: Kind): { fill: string; stroke: string } {
  switch (kind) {
    case 'data':
      return { fill: '#fff8ea', stroke: '#1a1614' };
    case 'model':
      return { fill: '#fef4d8', stroke: '#9f661b' };
    default:
      return { fill: '#ffffff', stroke: '#1a1614' };
  }
}

// --- Internal scene element shapes. These are the in-memory
//     representation; export_scene serialises them to the
//     .excalidraw JSON the renderer loads. We hold the full shape
//     (not a partial) so describe_scene can do real bbox checks.

interface SceneRect {
  type: 'rectangle';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed';
  roundness: { type: 3 } | null;
  roughness: number;
  fillStyle: 'solid';
  boundElements: Array<{ id: string; type: 'text' }>;
  customData?: Record<string, unknown>;
}

interface SceneText {
  type: 'text';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** Excalidraw stores the unwrapped source separately. Without
   * this field its renderer falls back to autoResize=true (default)
   * and the text floats out of the container. */
  originalText: string;
  /** false = wrap text inside the (width × height) we set; true =
   * grow the element to fit the text. We always want false on
   * container-bound text. */
  autoResize: boolean;
  fontSize: number;
  fontFamily: number;
  textAlign: 'center' | 'left';
  verticalAlign: 'middle' | 'top';
  strokeColor: string;
  containerId: string | null;
  customData?: Record<string, unknown>;
}

interface SceneFrame {
  type: 'frame';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Frame label drawn in the band above the frame. */
  name: string;
  /** Optional stroke override; defaults to chat-frame orange. */
  strokeColor?: string;
  customData?: Record<string, unknown>;
  /** Excalidraw v0.18 frame-skeleton fields. `children` is required by
   * `convertToExcalidrawElements`'s ExcalidrawElementSkeleton frame
   * variant — without it the skeleton is malformed and the frame is
   * dropped silently on the renderer side. The remaining fields pad
   * out the base-element shape so the converter doesn't reject the
   * skeleton on missing required base props. The in-MCP rasteriser
   * doesn't read any of these (it serializes state.elements straight
   * to .excalidraw); they exist purely so the renderer's
   * convertToExcalidrawElements call accepts the frame. */
  children?: readonly string[];
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  angle?: number;
  boundElements?: readonly unknown[];
  groupIds?: readonly string[];
}

interface SceneArrow {
  type: 'arrow';
  id: string;
  x: number;
  y: number;
  points: Array<[number, number]>;
  strokeColor: string;
  strokeWidth: number;
  roughness: number;
  startBinding: { elementId: string; focus: number; gap: number } | null;
  endBinding: { elementId: string; focus: number; gap: number } | null;
  label?: { text: string; fontSize: number; fontFamily: number; strokeColor: string };
  customData?: Record<string, unknown>;
}

export type SceneElement = SceneRect | SceneText | SceneArrow | SceneFrame;

// --- Per-MCP-instance scene state. `createSdkMcpServer` is per-call,
//     so each Pass 2 invocation gets its own fresh state by
//     construction. We hold elements + a counter for stable ids the
//     agent can reference back.

interface SceneState {
  elements: SceneElement[];
  /** Monotonic counter so ids are deterministic + readable
   * (`wb-rect-001`, `wb-text-001`, etc.). The agent sees these in
   * tool-call results and uses them to chain into `connect_nodes`. */
  counter: number;
  /** Diagram metadata the renderer needs (level, parent for L2,
   * mode='chat' so the wrapper namespaces ids per chat-frame). */
  meta: { level: 1 | 2; parent?: string; title?: string; mode?: 'pass2' | 'chat'; queryId?: string };
  /** Active chat frame id (mode='chat' only). When set, every
   * subsequent create/connect call stamps the new element's
   * `frameId` to it so Excalidraw groups it visually. */
  activeFrameId?: string;
  /** Read-only snapshot of pre-existing scene state (L1 + L2 + prior
   * chat frames) supplied to the chat agent at MCP construction time
   * via `priorScene`. Used by `read_diagram_state` so the agent can
   * see what's already on the canvas without re-emitting it. */
  priorScene?: SceneSnapshot;
  /** v3.2.1 — id of the currently-active wb-section. set by
   * create_section, stamped onto subsequent elements' customData so
   * the renderer + AC layer can reason about which content belongs to
   * which section. null if the agent hasn't created any section yet. */
  activeSectionId?: string;
  /** v3.2.1 — running bottom-y of the canvas. create_section uses this
   * to compute where the next section's frame should land
   * (bottom + 80px gap per spec §16.1). */
  lastBottomY: number;
  /** Round-13 streaming render. Throttled emitter the factory wires
   * up if `opts.onSceneSnapshot` is supplied. Called from
   * `pushElements` after each successful push so the renderer sees
   * partial scenes during authoring. No-op if streaming is disabled
   * (the factory leaves it undefined and pushElements just skips). */
  emitSnapshot?: () => void;
  /** Round-14b step-loop. Set by the `yield_step` tool when the agent
   * ends a step. The outer `runPass2StepLoop` reads this AFTER the
   * SDK query iterator drains, decides whether to terminate
   * (lastYield.done === true) or re-issue with the cached prefix +
   * the prior step's summary as next-turn context.
   *
   * `lastYield` is the most recent yield (cleared/overwritten per
   * step); `yieldHistory` is the append-only audit trail across
   * every step the agent has emitted. */
  lastYield?: YieldStepArgs;
  yieldHistory: YieldStepArgs[];
}

/** Round-14b — args supplied by the agent when calling `yield_step`. */
export interface YieldStepArgs {
  stepSummary: string;
  screenshotRequest?: boolean;
  done?: boolean;
}

export interface SceneSnapshot {
  /** All non-frame nodes already on the canvas, with their bbox + kind +
   * customData.fathomKind so the chat agent can avoid colliding with
   * paper-derived L1/L2 content when picking its own (x, y). */
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
    fathomKind?: string;
    level?: number;
    parentId?: string;
  }>;
  /** All frames already on the canvas (chat lanes from prior chat
   * turns). Same intent — find a free y in the chat lane. */
  frames: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    queryId?: string;
  }>;
  /** Total scene bbox so the chat agent has spatial awareness of the
   * existing canvas. Round 14d: the agent no longer hand-computes
   * frame placement from this — `place_chat_frame`'s wrapper sweeps
   * free space directly. The bbox stays useful for deictic answers
   * and self-debugging. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function newSceneState(
  level: 1 | 2 = 1,
  parent?: string,
  title?: string,
  mode: 'pass2' | 'chat' = 'pass2',
  queryId?: string,
  priorScene?: SceneSnapshot,
): SceneState {
  return {
    elements: [],
    counter: 0,
    meta: { level, parent, title, mode, queryId },
    priorScene,
    lastBottomY: 0,
    yieldHistory: [],
  };
}

/** Track the running bottom-y of the canvas so create_section can
 * stack the next section below the current bottom. Called from
 * pushElements after each emission. */
function bumpBottomY(state: SceneState, el: SceneElement): void {
  if (typeof (el as { y?: number }).y !== 'number') return;
  const y = (el as { y: number }).y;
  const h = (el as { height?: number }).height ?? 0;
  const bottom = y + h;
  if (bottom > state.lastBottomY) state.lastBottomY = bottom;
}

/** Build a globally-unique element id for this MCP call. L1 ids stay
 * compact (`wb-rect-001`, etc.). L2 ids are namespaced by parent
 * (`wb-l2-<parent>-rect-001`) so when the renderer merges L1 + N L2
 * scenes into one Excalidraw canvas, ids don't collide across calls.
 * Chat-mode ids are namespaced by queryId so successive chat turns
 * don't collide with each other or with L1/L2.
 * The agent never has to reason about the namespace — it just uses
 * whatever id the tool returns. */
function nextId(state: SceneState, prefix: string): string {
  state.counter++;
  const num = String(state.counter).padStart(3, '0');
  if (state.meta.mode === 'chat') {
    const q = state.meta.queryId ?? 'chat';
    return `wb-chat-${q}-${prefix}-${num}`;
  }
  if (state.meta.level === 1) return `wb-${prefix}-${num}`;
  const parent = state.meta.parent ?? 'orphan';
  return `wb-l2-${parent}-${prefix}-${num}`;
}

/** Round 14d — axis-aligned bounding-box overlap test. Inclusive on
 * shared edges (frames touching at a seam are NOT overlap). */
function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

/** Round 14d — collect AABBs for everything currently on the canvas
 * (own-state elements + priorScene's L1/L2 + prior chat frames). The
 * prior-scene boxes matter for chat mode because the chat agent's
 * fresh state.elements is empty at place_chat_frame time — the L1/L2
 * the user already sees lives in priorScene only. */
function collectOccupiedBoxes(
  state: SceneState,
): Array<{ x: number; y: number; w: number; h: number; tag: 'l1' | 'l2' | 'chat-frame' | 'other' }> {
  const out: Array<{ x: number; y: number; w: number; h: number; tag: 'l1' | 'l2' | 'chat-frame' | 'other' }> = [];
  for (const el of state.elements) {
    const tag = (el as { customData?: { fathomKind?: string } }).customData?.fathomKind === 'wb-chat-frame'
      ? 'chat-frame' as const
      : 'other' as const;
    out.push({ x: el.x, y: el.y, w: el.width, h: el.height, tag });
  }
  if (state.priorScene) {
    for (const n of state.priorScene.nodes ?? []) {
      const tag = n.id.startsWith('wb-l2-') ? 'l2' as const : 'l1' as const;
      out.push({ x: n.x, y: n.y, w: n.width, h: n.height, tag });
    }
    for (const f of state.priorScene.frames ?? []) {
      out.push({ x: f.x, y: f.y, w: f.width, h: f.height, tag: 'chat-frame' });
    }
  }
  return out;
}

/** Round 14d — sweep free space for a chat-frame placement. Per
 * ai-scientist §2.2(c): try the slot RIGHT of the L1/L2 area at the
 * L1 top first; if that's taken, drop one frame-height-plus-margin
 * and retry; up to ~6 candidates. Fall back to "below all existing
 * chat frames + margin" if nothing else fits. The agent never sees
 * this code — it just gets a clean (x, y) back from the wrapper. */
function findFreeFrameSlot(
  state: SceneState,
  frameW: number,
  frameH: number,
): { x: number; y: number } {
  const occupied = collectOccupiedBoxes(state);
  const GAP = 80;          // horizontal gap to the right of L1/L2
  const ROW_GAP = 40;      // vertical gap between stacked candidate rows
  const FALLBACK_GAP = 60; // gap below existing chat frames in fallback

  // Compute L1/L2 right edge + L1 top, defaulting to the canvas origin
  // when nothing exists yet (first chat in a freshly-cleared whiteboard).
  const paperBoxes = occupied.filter((b) => b.tag === 'l1' || b.tag === 'l2');
  const l1Right = paperBoxes.length > 0
    ? Math.max(...paperBoxes.map((b) => b.x + b.w))
    : 0;
  const l1Top = paperBoxes.length > 0
    ? Math.min(...paperBoxes.map((b) => b.y))
    : 0;

  // Candidate column to the right of paper content. Drop down by
  // `frameH + ROW_GAP` per attempt — that's the worst case where each
  // prior chat frame fills exactly one row at the same width.
  const baseX = l1Right + GAP;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 6; row++) {
    candidates.push({ x: baseX, y: l1Top + row * (frameH + ROW_GAP) });
  }
  for (const c of candidates) {
    const candidateBox = { x: c.x, y: c.y, w: frameW, h: frameH };
    if (!occupied.some((o) => boxesOverlap(o, candidateBox))) {
      return c;
    }
  }

  // Fallback: stack below the lowest existing chat frame. If none
  // exists yet (only L1/L2 boxes), drop below the lowest paper box.
  const chatBoxes = occupied.filter((b) => b.tag === 'chat-frame');
  if (chatBoxes.length > 0) {
    const lowest = chatBoxes.reduce((acc, b) => (b.y + b.h > acc.y + acc.h ? b : acc));
    return { x: lowest.x, y: lowest.y + lowest.h + FALLBACK_GAP };
  }
  if (paperBoxes.length > 0) {
    const lowest = paperBoxes.reduce((acc, b) => (b.y + b.h > acc.y + acc.h ? b : acc));
    return { x: baseX, y: lowest.y + lowest.h + FALLBACK_GAP };
  }
  return { x: baseX, y: l1Top };
}

/** Round 14d — for explicit-override placement, surface a soft warning
 * if the agent's chosen slot overlaps existing content. Returned as
 * a string for inclusion in the tool result; null when clean. */
function detectFrameOverlap(
  state: SceneState,
  x: number,
  y: number,
  w: number,
  h: number,
): string | null {
  const occupied = collectOccupiedBoxes(state);
  const candidate = { x, y, w, h };
  const collisions = occupied.filter((o) => boxesOverlap(o, candidate));
  if (collisions.length === 0) return null;
  return (
    `placed frame at (${x}, ${y}) ${w}×${h} overlaps ${collisions.length} ` +
    `existing element(s). If unintended, omit (x, y) so the wrapper sweeps ` +
    `a free slot, or pass look_at_scene-grounded coords.`
  );
}

/** Push one or more elements into scene state, stamping each with the
 * active chat frameId (if any) so Excalidraw groups them visually
 * AND adding `chatQueryId` to customData so the renderer's hydrate
 * filter can scope them to the right chat turn. No-op for non-chat
 * (Pass 2) calls. */
function pushElements(state: SceneState, ...els: SceneElement[]): void {
  for (const el of els) {
    if (state.activeFrameId && el.type !== 'frame') {
      (el as unknown as { frameId?: string }).frameId = state.activeFrameId;
    }
    if (state.meta.mode === 'chat') {
      const cd = (el.customData ?? {}) as Record<string, unknown>;
      el.customData = { ...cd, chatQueryId: state.meta.queryId, isChat: true };
    }
    // v3.2.1 — stamp the active section id on every emission so the AC
    // layer + renderer can group elements by section. Skip for the
    // section frame itself (it already carries its own id).
    if (state.activeSectionId && (el.customData as { fathomKind?: string } | undefined)?.fathomKind !== 'wb-section') {
      const cd = (el.customData ?? {}) as Record<string, unknown>;
      el.customData = { ...cd, sectionId: state.activeSectionId };
    }
    state.elements.push(el);
    bumpBottomY(state, el);
  }
  // Round-13 — streaming render. Notify the (throttled) emitter that
  // the scene has changed. The factory installs this iff the host
  // supplied `opts.onSceneSnapshot`; pass2 callers (production) wire
  // it through to an IPC `whiteboard:scene-stream` push. Smoke +
  // chat-mode authoring leave it undefined and the call is a no-op.
  state.emitSnapshot?.();
}

// `wrapToWidth` and `fitNodeSize` are now imported from
// `src/shared/whiteboard-text-fit.ts` per Dedup B (#71). The local
// `measureWidth` helper was a one-line `length * charW` wrapper that
// the shared module subsumes via the no-`measure` branch of
// `fitNodeSize`/`wrapToWidth`.

function ok(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true as const };
}

/** Filter out pseudo-elements (camera frames, etc.) before persistence
 * or render. Pseudo-elements carry authoring metadata (lecturer-narration
 * intent) but should never paint pixels. AC-NO-PSEUDO catches any that
 * leak past this strip pass. */
const PSEUDO_FATHOM_KINDS: Set<string> = new Set(['wb-camera']);
function stripPseudoElements(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter((el) => {
    const fk = (el.customData as { fathomKind?: string } | undefined)?.fathomKind;
    return !(typeof fk === 'string' && PSEUDO_FATHOM_KINDS.has(fk));
  });
}

// --- Render client. Lazily spawns scripts/render-real-server.mjs as a
//     subprocess; subsequent renders re-use the live Chromium + the
//     mounted Excalidraw page (~500ms per render after the ~10-15s
//     cold boot). Used by `look_at_scene`. The runPass2 caller MUST
//     call `dispose()` on the closure-captured client when its query
//     stream completes (or aborts), or the subprocess + headless
//     browser leak.

interface RenderResponse {
  id: number;
  ok: boolean;
  pngBase64?: string;
  error?: string;
}

class RenderClient {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: RenderResponse) => void>();
  private bootPromise: Promise<void> | null = null;
  private disposed = false;

  /** Resolve the path to render-real-server.mjs. In production
   * (Electron), `__dirname` of the bundled main process points at
   * the bundle dir; the scripts/ folder is at the repo root. We
   * walk up from this file's location to find scripts/. */
  private serverScriptPath(): string {
    // import.meta.url is undefined in CJS-compiled output but safe
    // in ESM. The Electron build emits CJS; we resolve from
    // process.cwd() as a fallback.
    let here: string;
    try {
      here = dirname(fileURLToPath(import.meta.url));
    } catch {
      here = process.cwd();
    }
    // Walk up to find scripts/ — works whether `here` is src/main/mcp/
    // (tsx dev path), out/main/ (electron-vite built path), or
    // app.asar.unpacked/scripts/ (packaged production). Test each
    // candidate with existsSync; the prior implementation only string-
    // matched, which always returned the first candidate even when
    // it pointed at a non-existent path (root cause of the
    // `Cannot find module '/Users/ashrya/Desktop/scripts/render-real-server.mjs'`
    // crash observed in dev — `here` was `/Users/ashrya/Desktop/PdfReader/out/main`,
    // first candidate walked up THREE levels to `/Users/ashrya/Desktop/scripts`,
    // which doesn't exist; the loop happily returned it because every
    // candidate's string contains 'scripts/render-real-server.mjs').
    const candidates = [
      // Source-tree path from pipeline/mcp/ in either src/ or dist/.
      // First match wins; existsSync gates each.
      join(here, '..', '..', '..', 'scripts', 'render-real-server.mjs'),
      join(here, '..', '..', 'scripts', 'render-real-server.mjs'),
      join(here, '..', 'scripts', 'render-real-server.mjs'),
      // Process-cwd fallback for when the consumer runs from the
      // repo root (e.g. `node examples/demo/run.mjs`).
      join(process.cwd(), 'scripts', 'render-real-server.mjs'),
      // Consumers that install this package as a dependency: the
      // scripts/ folder is shipped relative to the package root, so
      // walking up from `dist/pipeline/mcp/` lands at `<pkg>/scripts/`.
      join(here, '..', '..', '..', '..', 'scripts', 'render-real-server.mjs'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // None found — return the cwd-relative one and let spawn throw a
    // clear error (its stderr will surface via inherit), with the
    // candidate list logged so a future debug session can see what
    // we tried.
    console.warn(
      '[Whiteboard render-server] could not locate render-real-server.mjs; tried: ' +
        candidates.join(', '),
    );
    return candidates[candidates.length - 1];
  }

  private async boot(): Promise<void> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = (async () => {
      const scriptPath = this.serverScriptPath();
      const child = spawn('node', [scriptPath], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      this.child = child;
      const rl = readline.createInterface({ input: child.stdout! });
      this.rl = rl;
      let readyResolver: (() => void) | null = null;
      const readyP = new Promise<void>((r) => {
        readyResolver = r;
      });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg: RenderResponse & { ready?: boolean };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready) {
          readyResolver?.();
          return;
        }
        const handler = this.pending.get(msg.id);
        if (handler) {
          this.pending.delete(msg.id);
          handler(msg);
        }
      });
      child.on('exit', (code) => {
        // Reject any in-flight requests; further calls fail fast.
        for (const handler of this.pending.values()) {
          handler({ id: -1, ok: false, error: `render-server exited with code ${code}` });
        }
        this.pending.clear();
        this.disposed = true;
      });
      // 35s budget for esbuild + Chromium + Excalidraw cold start.
      // First render in standalone smoke was 13.5s; double + buffer.
      await Promise.race([
        readyP,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('render-server boot timeout')), 35000),
        ),
      ]);
    })();
    return this.bootPromise;
  }

  async render(scene: unknown, scale: number = 2): Promise<Buffer> {
    if (this.disposed) throw new Error('RenderClient disposed');
    await this.boot();
    if (!this.child || !this.child.stdin) throw new Error('render-server not running');
    const id = this.nextId++;
    const respPromise = new Promise<RenderResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.child.stdin.write(JSON.stringify({ id, op: 'render', scene, scale }) + '\n');
    const resp = await Promise.race([
      respPromise,
      new Promise<RenderResponse>((_, rej) =>
        setTimeout(() => rej(new Error('render timeout (60s)')), 60000),
      ),
    ]);
    if (!resp.ok || !resp.pngBase64) {
      throw new Error(resp.error ?? 'render failed without error');
    }
    return Buffer.from(resp.pngBase64, 'base64');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.child) return;
    try {
      // Best-effort graceful shutdown; if it doesn't respond in 1s,
      // SIGTERM the process directly.
      const child = this.child;
      child.stdin?.write(JSON.stringify({ id: -1, op: 'shutdown' }) + '\n');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ok */
          }
          resolve();
        }, 1000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ok */
      }
    }
    this.rl?.close();
    this.child = null;
    this.rl = null;
  }
}

// --- The diagram guide the agent reads at the start of each call.
//     Documents the spec rules so the agent doesn't need them in the
//     system prompt repeatedly (helps caching).

const DIAGRAM_GUIDE = `# Fathom whiteboard — diagram quality bar

You are authoring a hand-drawn-style diagram for a research paper using these tools. Hard rules:

## L1 = the paper's TOP-LEVEL pipeline (read this twice)

This is the most common failure mode and the only one the user cannot tolerate. **Level 1 captures the paper's top-level architecture / contribution / pipeline — what the paper as a whole does.** It is NEVER the internals of one sub-component, never the inside of one block.

The mental check: **"What would Figure 1 of this paper show?"** That's L1. If your nodes look like they belong inside one box of Figure 1, you're at L2 or L3.

Equivalent reframings (apply whichever is clearest for the paper):
- **Pipeline papers** (Transformer, ResNet, MapReduce, BERT, ReconViaGen): L1 = input → main stages → output. The named architecture's outermost diagram.
- **Algorithm papers**: L1 = problem setup → core algorithm steps → result. Not the loop body's internals.
- **System papers**: L1 = component-level architecture (clients ↔ servers ↔ storage), not the lock-acquisition path inside one server.
- **Theory papers**: L1 = setup → main theorem → corollaries / proof outline. Not an inference rule.

### Worked example — "Attention Is All You Need"

CORRECT L1 (5 nodes, top-level encoder-decoder pipeline):
  1. \`Inputs\` (input) — source + target tokens
  2. \`Token+Pos Embed\` (process)
  3. \`Encoder ×6\` (model, drillable=true) — the novel stack
  4. \`Decoder ×6\` (model, drillable=true) — uses encoder output
  5. \`Linear+Softmax\` (output) — next-token probabilities

L2 of \`Encoder ×6\` (zoom-in, NEVER repeats L1 nodes): Multi-Head Self-Attn → Add+Norm → Position-wise FFN → Add+Norm.

L2 of \`Decoder ×6\` (zoom-in, NEVER repeats L1 nodes): Masked MHA → Add+Norm → Cross-Attn (K,V from encoder) → Add+Norm → FFN → Add+Norm.

WRONG L1 — every one of these is "I went too deep on one block":
- "Q, K, V inputs" / "Scaled Dot-Product" / "Element-wise Sum" / "Position-wise FFN" / "Add & Norm" — these are L2 internals of Encoder/Decoder. They never appear at L1.
- "Repeat ×6 → Decoder" — describes a control-flow detail of one block, not the paper's top-level shape.

### Worked example — ReconViaGen-style pipeline paper

CORRECT L1 (5 nodes, the reconstruction loop): Input Frames → Recon Conditioning (model) → SS Flow → SLAT Flow → 3D Output. Side branches (Pose Refinement, Velocity Compensation) drop to row 2 feeding back into the main path.

L2 of \`Recon Conditioning\`: the components inside that block — never re-listing SS Flow or SLAT Flow.

## Anti-pattern detector (run this before you commit a node)

Ask: "If a reader saw only my 5 L1 nodes, could they explain in one sentence what the paper as a whole does?" If the answer is no — you're at the wrong level.

Concrete red flags:
- **Verb-of-computation labels**: if a label starts with what the block COMPUTES rather than naming the BLOCK ("Q,K,V inputs", "scaled dot-product", "element-wise sum", "softmax over logits", "compute gradient") — you've gone too low. Step back: ask "what's the bigger named module that contains this?" Use that name instead.
- **Internal-only terminology**: if your labels would only make sense to someone already inside one specific block ("masked attention", "key-value cache hit"), you've zoomed past the architecture.
- **Missing endpoints**: L1 must include the input(s) the paper takes and the output(s) it produces. If your L1 has neither raw input nor terminal output, it's a fragment, not a pipeline.
- **No "model" node, or multiple "model" nodes**: exactly ONE L1 node should be \`kind: "model"\` — the novel contribution. If you can't pick one, you don't yet understand what the paper is contributing.

## L2 = zoom-in of ONE L1 node — and ONLY that node's interior

When you author an L2 frame, the parent L1 node is given to you. The L2 frame's job: show what's INSIDE that one parent. **Never repeat any L1 node in any L2 frame** — those are sibling concepts, not children. If the agent writes "Q, K, V inputs" in L2 of Encoder and ALSO in L2 of Decoder, that's a duplication bug — those are different blocks; their internals are different specialised content.

Each L2 frame is specialised content per parent: Encoder's L2 ≠ Decoder's L2 even if some operations rhyme. Use the parent block's own terminology (the paper's own subsection names) to label the L2 nodes.

## Structure
- **At most 5 nodes per diagram.** Cog reviewer veto. Group anything beyond 5 into a single drillable parent node.
- **Horizontal pipeline by default** (left-to-right). Side branches (e.g. "this output also feeds into...") drop to a second row — that's correct ELK layered placement, not a layout failure.
- **Edges follow the paper's narrative arrows.** Don't invent edges that aren't in the paper.
- **L1 must include input + output endpoints** so the diagram reads as a complete pipeline, not a fragment of one.

## Node anatomy
- Each node has a label (≤ 24 chars) + an optional summary (≤ 25 words).
- **Use the paper's own terminology** for labels — never rename a component to be more "intuitive."
- Mark a node \`drillable: true\` when it contains 2+ sub-components. The renderer paints a dashed inner border + ⌖ glyph at bottom-right. The novel contribution at L1 is almost always drillable.
- Mark exactly ONE node as \`kind: "model"\` — the novel contribution. The renderer fills it with warm beige (#fef4d8) so the user's eye lands there first.
- Other kinds: \`input\`, \`output\`, \`process\`, \`data\` — all render with neutral fill. Use \`process\` for transformations, \`input\` for raw inputs, \`output\` for terminal results, \`data\` for stored intermediates.
- Citations: when you commit a quote from the paper to a node, attach it as \`citation: {page, quote}\`. The renderer paints a small amber square at the node's top-right.

## Layout
- Place L1 nodes at increasing x, starting at x=0 with ~120 px gaps. Don't overlap.
- The wrapper sizes each rect to fit its bound text — you don't compute width yourself; just pass label + summary to \`create_node_with_fitted_text\` and use the returned width to position the next node.
- For Level 2 diagrams: still horizontal, but the renderer will offset the entire scene to sit BELOW its parent L1 node (post-process step). You don't need to position L2 nodes relative to L1.

## Workflow
1. Read this guide ONCE at start.
2. **Sanity-check your level before creating any node.** Restate to yourself: "This is L<N> of the <paper title> paper. The 5 nodes I'm about to author are <list>. They capture <top-level pipeline | interior of parent X>." If you can't say this cleanly, re-read the Pass 1 understanding doc's "Suggested Level <N> diagram" section.
3. \`create_node_with_fitted_text\` for each node, in pipeline order.
4. \`connect_nodes\` for each edge in the paper's narrative.
5. \`describe_scene\` to verify the structural invariants (counts, bindings, ≤5 ceiling).
6. \`look_at_scene\` to SEE the actual rendered PNG. Critique it: no node overlap, no text overflow, no edges crossing nodes, reads as a workflow left-to-right, model node visually distinct, no dense clusters. If anything's wrong, fix it via more tool calls and look again. Cap at **3 self-critique rounds** — past 3 you are thrashing.
7. \`export_scene\` to finalise.

## What NOT to do
- Don't try to render Mermaid syntax — use the create/connect tools directly.
- Don't try to make the diagram visually "pretty" — clarity over aesthetic.
- Don't author more than 5 nodes (parser will trim, banner will fire).
- Don't pre-render text positions yourself — \`create_node_with_fitted_text\` handles it.
- Don't skip \`describe_scene\` + \`look_at_scene\` before \`export_scene\` — those are your self-critique loop.
- Don't loop on \`look_at_scene\` past 3 rounds — at that point fix the obvious thing and ship.
- **Don't put one block's internals at L1** (most-violated rule — see "L1 = the paper's TOP-LEVEL pipeline" above).
- **Don't repeat L1 node names inside any L2 frame** — L2 is the interior of one parent, not a re-statement of the L1 pipeline.
`;

/** Build an SDK MCP server scoped to a single Pass 2 call AND
 * return a getScene() snapshot of the in-memory state.
 *
 * Plug `result.mcp` into the SDK `query()` call's `mcpServers`
 * config (e.g. `mcpServers: { whiteboard: result.mcp }`) — the agent
 * authors the diagram by calling tools inside the same query stream.
 *
 * Call `result.getScene()` AFTER the query stream completes to read
 * the in-memory scene state directly. This is a defensive backstop:
 * even if the agent forgets to call `export_scene`, runPass2 can
 * still persist the .excalidraw to the sidecar by snapshotting state
 * here.
 *
 * @param level   1 or 2; threaded into customData on every element
 *                so the renderer's hydrate logic can route them.
 * @param parent  for level=2, the parent L1 node id. The renderer's
 *                post-process step uses this to vertically offset
 *                the L2 scene below the parent.
 * @param title   optional diagram title (renders at top of frame).
 */
export function createWhiteboardMcpWithStateAccess(opts: {
  level: 1 | 2;
  parent?: string;
  title?: string;
  /** 'pass2' (default) — Pass 2 agent authoring an L1/L2 frame.
   *  'chat' — chat agent authoring a new chat-lane frame in response
   *  to a user question. Enables `place_chat_frame` + `read_diagram_state`,
   *  namespaces ids by queryId, stamps `frameId` on all created elements
   *  so they group inside the active chat frame. */
  mode?: 'pass2' | 'chat';
  /** Required when mode='chat'. Stable id for the chat turn so all
   * elements + the frame share the namespace. */
  queryId?: string;
  /** Snapshot of the scene already on the canvas (L1 + L2 + prior
   * chat frames). Read-only — exposed via `read_diagram_state` so
   * the chat agent can place its frame in a free spot and reference
   * existing nodes. */
  priorScene?: SceneSnapshot;
  /** Round-11: in-product visual self-loop. When set, enables the
   * `request_critic_review` tool — the agent rasterises the current
   * scene + invokes the vision critic (whiteboard-critique.ts) +
   * receives a structured verdict as a text block, all without
   * leaving its query stream. Both fields are required to enable the
   * tool; if either is missing the tool returns an error nudging the
   * agent to call export_scene instead. */
  paperHash?: string;
  indexPath?: string;
  /** Threaded through to runCritique so it has no Electron dep itself.
   * Production: resolveClaudeExecutablePath(); smoke: `which claude`. */
  pathToClaudeCodeExecutable?: string;
  /** Streaming render hook (round-13). Called with the FULL current
   * `state.elements` array every time the scene mutates, so the
   * renderer can show partial scenes as the agent authors them rather
   * than waiting for export_scene. The factory throttles internally
   * (leading + trailing edge, 80 ms window) so 30 rapid pushElements
   * calls produce ~2 IPC events instead of 30. The callback runs on
   * Node's event loop in the main process — the IPC layer sends it
   * over to the renderer. Pass undefined to disable streaming.
   *
   * The callback receives a copy-on-emit reference; it must serialise
   * (or send by IPC, which copies) before the next push lands or the
   * recipient sees a torn array. The IPC structured-clone path does
   * this for free. */
  onSceneSnapshot?: (elements: readonly SceneElement[]) => void;
}): {
  mcp: ReturnType<typeof createSdkMcpServer>;
  getScene: () => {
    type: 'excalidraw';
    version: number;
    source: string;
    elements: SceneElement[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  };
  /** For chat mode: the active frame id once `place_chat_frame` has
   * been called. Used by the IPC layer to thread the frameId back
   * to the renderer so the side-chat UI can wire "Jump to chart". */
  getActiveFrameId: () => string | undefined;
  /** Round-14b — read the most recent yield_step args. Undefined if
   * the agent hasn't called yield_step yet in the current step. */
  getLastYield: () => YieldStepArgs | undefined;
  /** Round-14b — append-only audit trail of every yield_step call
   * across the whole step-loop run. Useful for the next step's
   * prompt context + for end-of-run logging. */
  getYieldHistory: () => readonly YieldStepArgs[];
  /** Round-14b — clear `lastYield` between steps so the outer loop
   * can detect "agent ran a turn and never called yield_step"
   * (treated as an implicit yield with empty summary). */
  clearLastYield: () => void;
  /** Round-14c — rasterise an arbitrary scene to a PNG buffer using
   * the same render-server subprocess that backs `look_at_scene` /
   * the in-MCP critic. The orchestrator uses this to run a one-shot
   * post-export critic call (advisory verdict) AFTER the step-loop
   * finishes cleanly. The render-server is disposed by `dispose()`,
   * so this MUST be called before dispose. */
  renderScene: (scene: {
    type: 'excalidraw';
    version: number;
    source: string;
    elements: SceneElement[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  }) => Promise<Buffer>;
  /** Tear down the render-server subprocess if `look_at_scene` was
   * ever invoked. ALWAYS call this when runPass2's query stream
   * completes (success, abort, or error path) — otherwise the
   * subprocess + headless Chromium leak. Safe to call multiple times.
   * Also flushes the streaming-render trailing-edge timer if any. */
  dispose: () => Promise<void>;
} {
  // Re-implement createWhiteboardMcp inline so we share the closure
  // over `state`. Same tools as above; difference is the closure
  // exposed via getScene().
  const mode = opts.mode ?? 'pass2';
  const state = newSceneState(
    opts.level,
    opts.parent,
    opts.title,
    mode,
    opts.queryId,
    opts.priorScene,
  );

  // Lazy render client — subprocess is only spawned the first time
  // the agent calls `look_at_scene`. If the agent never asks for the
  // visual, we incur zero browser-launch cost.
  const renderClient = new RenderClient();

  // Round-13 streaming render — leading + trailing edge throttle.
  // 30 rapid `pushElements` (one per agent tool call) collapse to ~2
  // IPC events: the first fires immediately so the user-visible
  // update is fast; intermediate calls within the 80 ms window queue;
  // a single trailing-edge flush carries the final state so the last
  // update is never lost. Inline (no lodash dep) to keep main bundle
  // small.
  const STREAM_THROTTLE_MS = 80;
  let streamLastFiredAt = 0;
  let streamTrailingTimer: ReturnType<typeof setTimeout> | null = null;
  const fireStream = (): void => {
    if (!opts.onSceneSnapshot) return;
    streamLastFiredAt = Date.now();
    try {
      // Pass a shallow-copy reference. The IPC `safeSend` path
      // structured-clones over to the renderer so the recipient sees
      // a stable snapshot even if pushElements appends after this
      // returns. Passing state.elements directly is therefore safe;
      // no defensive `.slice()` needed.
      opts.onSceneSnapshot(state.elements);
    } catch (err) {
      console.warn(
        '[Whiteboard scene-stream] emitter threw:',
        err instanceof Error ? err.message : err,
      );
    }
  };
  if (opts.onSceneSnapshot) {
    state.emitSnapshot = (): void => {
      const now = Date.now();
      const sinceLast = now - streamLastFiredAt;
      if (sinceLast >= STREAM_THROTTLE_MS) {
        // Leading edge — fire immediately.
        if (streamTrailingTimer !== null) {
          clearTimeout(streamTrailingTimer);
          streamTrailingTimer = null;
        }
        fireStream();
        return;
      }
      // Within the throttle window. Schedule (or re-schedule) a
      // trailing-edge flush so the final state always lands.
      if (streamTrailingTimer !== null) clearTimeout(streamTrailingTimer);
      streamTrailingTimer = setTimeout(() => {
        streamTrailingTimer = null;
        fireStream();
      }, STREAM_THROTTLE_MS - sinceLast);
    };
  }

  // Round-11: per-session counter for `request_critic_review`. Capped at
  // 3 rounds — past that, the agent gets a forced pass:true verdict +
  // a "max critique rounds reached; proceed to export" note so it
  // breaks out of the loop instead of thrashing.
  const CRITIC_REVIEW_MAX_ROUNDS = 3;
  let criticReviewRounds = 0;

  const mcp = createSdkMcpServer({
    name: 'fathom-whiteboard',
    version: '1.0.0',
    tools: [
      tool('read_diagram_guide', 'Read the Fathom whiteboard quality bar.', {}, async () =>
        ok(DIAGRAM_GUIDE),
      ),
      tool(
        'create_node_with_fitted_text',
        'Create a rounded rectangle node with bound label + (optional) summary text. Auto-sized to fit. Returns node_id. ' +
          'BEFORE CALLING: confirm this node belongs at the current diagram level. ' +
          'L1 nodes name top-level pipeline blocks (Encoder ×6, Decoder ×6 — what Figure 1 of the paper would show). ' +
          'L1 nodes are NEVER one block\'s internals (Q/K/V inputs, scaled dot-product, element-wise sum — those belong in L2 of the parent block). ' +
          'L2 nodes name the interior of ONE specified parent — never re-list any L1 sibling node. ' +
          'See read_diagram_guide for the full anti-pattern detector.',
        {
          label: z.string().min(1).max(24),
          summary: z.string().max(200).optional(),
          kind: z.enum(KINDS),
          x: z.number(),
          y: z.number(),
          drillable: z.boolean().optional(),
          /** v3.2.1 — semantic role drives FILL color per critic rule 2.
           * input → blue, output → green, process → purple, math → amber,
           * noise → red, neutral → cream. If omitted, role is derived
           * from kind for back-compat. */
          role: z.enum(ROLES).optional(),
          citation: z
            .object({ page: z.number().int().positive(), quote: z.string().max(400) })
            .optional(),
          figure_ref: z
            .object({ page: z.number().int().positive(), figure: z.number().int().positive() })
            .optional(),
          /** v3.2.1 round-8 — round-7 user critique: every architecture-named
           * component must be paired with a visible "→ <question>" subtitle
           * that traces back to the paper's ground problem (rubric §"Components
           * must be framed as answers to ground-problem questions"). Pass the
           * question string here; the wrapper emits a sibling wb-node-question
           * text element directly below this rect, wrapped to the rect's width.
           * The question must START with "→" (the wrapper auto-prepends if
           * missing) so the AC-COMPONENT-HAS-QUESTION predicate can detect it.
           * Pass an empty string ONLY for nodes that are NOT named components
           * (axis endpoints, decorative shapes). For every node naming a
           * mechanism / module / sub-system, this field is mandatory at the
           * authoring level — AC-COMPONENT-HAS-QUESTION fires FAIL otherwise. */
          question: z.string().max(160).optional(),
        },
        async (args) => {
          const label = args.label.length > 24 ? args.label.slice(0, 23) + '…' : args.label;
          const summary = (args.summary ?? '').trim().length > 110
            ? (args.summary ?? '').trim().slice(0, 109) + '…'
            : (args.summary ?? '').trim();
          // Heuristic dimensions — Excalidraw's convertToExcalidrawElements
          // accepts the (width, height) we provide and auto-wraps the
          // label.text inside it. We OVER-estimate height (better to
          // have whitespace than to clip text) since Excalidraw's auto-
          // fit honours width but does NOT auto-grow rect height when
          // the wrapped text overflows. Empirical: at 13px Excalifont,
          // ~28-30 chars fit per line in a 320px rect (with center
          // alignment + padding). Round up + add headroom.
          const w = NODE_MAX_WIDTH;
          // Label is one line; summary wraps. Conservative chars/line
          // for SUMMARY_FONT inside (w - 2*pad) at center align ≈ 30.
          const innerW = w - 2 * NODE_INNER_PAD_X;
          const summaryCharsPerLine = Math.max(20, Math.floor(innerW / 9));
          const summaryLineCount = summary
            ? Math.max(2, Math.ceil(summary.length / summaryCharsPerLine))
            : 0;
          const labelLineH = LABEL_FONT * LINE_HEIGHT_RATIO;
          const summaryLineH = SUMMARY_FONT * LINE_HEIGHT_RATIO;
          const h = Math.max(
            NODE_MIN_HEIGHT,
            Math.ceil(labelLineH + summaryLineCount * summaryLineH + 2 * NODE_INNER_PAD_Y + 8),
          );
          // Round-10 user critique 2026-04-27 (CLAUDE.md §8): "multi-view
          // box body text overflows outside the box" — and round-9 AC
          // surfaced node-questions whose right edge exceeded section
          // bounds. Tool-layer rejection: if the node's bbox + its
          // future wb-node-question subtitle (width = node width) would
          // extend past the active section's right or bottom edge,
          // reject with a precise diagnostic. Section bounds come from
          // the wb-section header bbox keyed by activeSectionId.
          const activeSidNode = state.activeSectionId;
          if (activeSidNode) {
            const sectionHeader = state.elements.find((e) => {
              const cd = e.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string } | undefined;
              return cd?.fathomKind === 'wb-section' && cd?.isHeader === true && cd?.sectionId === activeSidNode;
            });
            if (sectionHeader) {
              const sx = (sectionHeader as { x?: number }).x;
              const sy = (sectionHeader as { y?: number }).y;
              const sw = (sectionHeader as { width?: number }).width;
              const sh = (sectionHeader as { height?: number }).height;
              if (typeof sx === 'number' && typeof sw === 'number') {
                const SECTION_PAD = 30;
                const sectionRight = sx + sw - SECTION_PAD;
                const nodeRight = args.x + w;
                if (nodeRight > sectionRight + 1) {
                  const overflowPx = Math.round(nodeRight - sectionRight);
                  const suggestedX = Math.max(sx + SECTION_PAD, sectionRight - w);
                  const suggestedW = Math.max(NODE_MIN_HEIGHT, sectionRight - args.x);
                  return err(
                    `create_node_with_fitted_text: node '${label}' at x=${args.x} width=${w} ` +
                      `right edge ${nodeRight} extends ${overflowPx}px past section right edge ${sectionRight} ` +
                      `(section ${sectionHeader.id ?? '?'} x=${sx} width=${sw} minus ${SECTION_PAD}px padding). ` +
                      `Move x to ≤${Math.round(suggestedX)} (right-aligns the node to section right) ` +
                      `OR shorten the label/summary so the node fits a smaller width (current width is fixed at ${w}px). ` +
                      `If you must place at this x, the maximum width that would fit is ${Math.round(suggestedW)}px.`,
                  );
                }
                // Bottom-edge check (rarely fires — sections grow downward — but guard anyway).
                if (typeof sy === 'number' && typeof sh === 'number') {
                  const sectionBot = sy + sh;
                  // Node's effective bottom = node bbox + question subtitle (~36px).
                  const nodeBot = args.y + h + 36;
                  if (nodeBot > sectionBot + 1) {
                    // Permissive on bottom — sections auto-expand. Just log via debug if env set.
                    if (process.env.WBSMOKE_DEBUG === '1') {
                      // eslint-disable-next-line no-console
                      console.log(
                        `[create_node_with_fitted_text] node '${label}' bottom ${nodeBot} > section bottom ${sectionBot} — section will need to grow.`,
                      );
                    }
                  }
                }
              }
            }
          }
          // Round-12a: AC-NODE-VS-NODE-OVERLAP. Round 11 happened to ship
          // 0 node overlaps (lucky), but no wrapper enforces it explicitly.
          // The round-10 critic's STRONG ask was a wrapper rejection at
          // ≥4-8px gutter between sibling nodes in the same section. We
          // pick 8px to be generous on visual breathing room.
          //
          // Same-section scope: zones in different sections naturally
          // sit at different y-bands; an overlap-check across sections
          // would false-positive for tightly-stacked sections.
          const NODE_GUTTER = 8;
          if (activeSidNode) {
            const newBox = {
              xMin: args.x,
              yMin: args.y,
              xMax: args.x + w,
              yMax: args.y + h,
            };
            for (const el of state.elements) {
              if (el.type !== 'rectangle') continue;
              const cd = el.customData as { fathomKind?: string; sectionId?: string } | undefined;
              if (cd?.fathomKind !== 'wb-node') continue;
              if (cd?.sectionId && cd.sectionId !== activeSidNode) continue;
              const ex = (el as { x?: number }).x;
              const ey = (el as { y?: number }).y;
              const ew = (el as { width?: number }).width;
              const eh = (el as { height?: number }).height;
              if (typeof ex !== 'number' || typeof ey !== 'number') continue;
              if (typeof ew !== 'number' || typeof eh !== 'number') continue;
              const otherBox = {
                xMin: ex - NODE_GUTTER,
                yMin: ey - NODE_GUTTER,
                xMax: ex + ew + NODE_GUTTER,
                yMax: ey + eh + NODE_GUTTER,
              };
              const ixMin = Math.max(newBox.xMin, otherBox.xMin);
              const ixMax = Math.min(newBox.xMax, otherBox.xMax);
              const iyMin = Math.max(newBox.yMin, otherBox.yMin);
              const iyMax = Math.min(newBox.yMax, otherBox.yMax);
              if (ixMax <= ixMin || iyMax <= iyMin) continue; // disjoint, allowed
              // Overlap with gutter: reject. Suggest a non-overlap x or y.
              const otherLabel =
                (el as { label?: { text?: string } }).label?.text?.split('\n')[0] ?? (el.id ?? 'node');
              const suggestedX = Math.ceil(ex + ew + NODE_GUTTER);
              const suggestedYBelow = Math.ceil(ey + eh + NODE_GUTTER);
              return err(
                `create_node_with_fitted_text: new node '${label}' bbox (${args.x},${args.y})–(${newBox.xMax},${newBox.yMax}) ` +
                  `overlaps existing node '${otherLabel}' (${el.id ?? '?'}) bbox (${ex},${ey})–(${ex + ew},${ey + eh}) ` +
                  `(required gutter ${NODE_GUTTER}px). Sibling nodes in the same section need a visual gap. ` +
                  `Fix: shift x to ≥ ${suggestedX} (place to the right of the existing node) ` +
                  `OR shift y to ≥ ${suggestedYBelow} (place below) ` +
                  `OR pick a different row within the section.`,
              );
            }
          }
          // v3.2.1 — role-driven fill takes precedence; kind:model still
          // overrides STROKE so the novel-contribution accent remains
          // (warm amber stroke regardless of role-derived fill).
          const role: Role = args.role ?? defaultRoleForKind(args.kind);
          const rolePal = rolePalette(role);
          const isModel = args.kind === 'model';
          const palette = {
            fill: rolePal.fill,
            stroke: isModel ? '#f59e0b' : rolePal.stroke,
          };
          const drillable = args.drillable === true;
          const rectId = nextId(state, 'rect');
          // Combined text — Excalidraw will wrap it inside the rect at
          // render time. Bigger label font, smaller summary, separated
          // by a blank line for visual hierarchy.
          const labelText = summary ? `${label}\n${summary}` : label;
          pushElements(
            state,
            // Labeled-shape skeleton (ValidContainer in Excalidraw types).
            // The renderer's convertToExcalidrawElements call expands
            // this into a rect + auto-fitted bound text. Drops 60+ lines
            // of manual text-sizing + pre-wrap + originalText/autoResize
            // gymnastics. (LABEL-1 refactor 2026-04-26.)
            {
              type: 'rectangle',
              id: rectId,
              x: args.x,
              y: args.y,
              width: w,
              height: h,
              strokeColor: palette.stroke,
              backgroundColor: palette.fill,
              strokeWidth: isModel ? 2 : 1,
              strokeStyle: drillable ? 'dashed' : 'solid',
              roundness: { type: 3 },
              roughness: 1,
              fillStyle: 'solid',
              boundElements: [],
              // The label sugar — convertToExcalidrawElements expands
              // this into a bound text element at render time. We pass
              // both label fontSize (used by Excalidraw's measureText)
              // and our font family (Excalifont = 5).
              label: {
                text: labelText,
                fontSize: summary ? SUMMARY_FONT : LABEL_FONT,
                fontFamily: FONT_FAMILY_EXCALIFONT,
                textAlign: 'center',
                verticalAlign: 'middle',
              },
              customData: {
                fathomKind: 'wb-node',
                nodeId: rectId,
                level: state.meta.level,
                parentId: state.meta.parent,
                kind: args.kind,
                role,
                drillable,
                citation: args.citation,
                figureRef: args.figure_ref,
                generatedAt: new Date().toISOString(),
              },
            } as unknown as SceneRect,
          );
          if (args.citation) {
            const cmId = nextId(state, 'cite');
            pushElements(state, {
              type: 'rectangle',
              id: cmId,
              x: args.x + w - 14,
              y: args.y - 6,
              width: 10,
              height: 10,
              strokeColor: '#9f661b',
              backgroundColor: '#9f661b',
              strokeWidth: 1,
              strokeStyle: 'solid',
              roundness: null,
              roughness: 1,
              fillStyle: 'solid',
              boundElements: [],
              customData: {
                fathomKind: 'wb-citation',
                nodeId: rectId,
                level: state.meta.level,
                citation: args.citation,
              },
            });
          }
          if (drillable) {
            const glyphId = nextId(state, 'drill');
            pushElements(state, {
              type: 'text',
              id: glyphId,
              x: args.x + w - 16,
              y: args.y + h - 18,
              width: 14,
              height: 18,
              text: '⌖',
              originalText: '⌖',
              autoResize: false,
              fontSize: 14,
              fontFamily: FONT_FAMILY_HELVETICA,
              textAlign: 'left',
              verticalAlign: 'top',
              strokeColor: '#9f661b',
              containerId: null,
              customData: {
                fathomKind: 'wb-drill-glyph',
                nodeId: rectId,
                level: state.meta.level,
                drillable: true,
              },
            });
          }
          // v3.2.1 round-8 — emit "→ <question>" subtitle below the node
          // when the agent passed a question. This is the visible
          // grounding for the rubric's component-as-answer rule. The
          // text element is sized via wrapToWidth so AC-CONTAINER-TEXT-FIT
          // (round-8) can predict its actual height and assert no overflow.
          // Geometry constants (kept local + documented so the AC predicate
          // can mirror exactly):
          //   x       = node x (aligned to node's left edge)
          //   y       = node bottom + NODE_QUESTION_GAP_Y
          //   width   = node width (same horizontal extent)
          //   pad-X   = NODE_QUESTION_PAD_X each side
          //   font    = 12px Excalifont (sans), italic-ish via lighter color
          //   line-h  = 1.4 × fontSize
          const NODE_QUESTION_GAP_Y = 8;
          const NODE_QUESTION_PAD_X = 0; // text uses node's full width as inner
          const NODE_QUESTION_FONTSIZE = 12;
          const NODE_QUESTION_CHAR_W = 7.5; // px/char @ fontSize 12, mixed-case sans (matches SUMMARY_CHAR_W slope)
          const NODE_QUESTION_LINE_H = Math.ceil(NODE_QUESTION_FONTSIZE * 1.4);
          const rawQ = (args.question ?? '').trim();
          if (rawQ.length > 0) {
            const qTextRaw = rawQ.startsWith('→') ? rawQ : `→ ${rawQ}`;
            const innerW = Math.max(40, w - 2 * NODE_QUESTION_PAD_X);
            const lines = wrapToWidth(qTextRaw, NODE_QUESTION_CHAR_W, innerW);
            const lineCount = Math.max(1, lines.length);
            const qHeight = lineCount * NODE_QUESTION_LINE_H + 4;
            // Round-12a A4: insert \n per the wrap. Without this, the
            // text element's `text` field carried the unwrapped string,
            // and AC-PARAGRAPH-WIDTH-FIT (which predicts width from
            // text.length × char_w) mis-flagged overflow even when the
            // renderer would wrap the line correctly. Emit the reflowed
            // text so renderer + predicate agree.
            const qText = lines.join('\n');
            // Round-12a A4 (continued): predict the question's visual
            // bbox against the active section's right/bottom edges. The
            // existing section-bounds check at line ~893 only measures
            // the NODE rect; the question subtitle that the wrapper
            // emits BELOW the node was unchecked. With wrap-by-node-width
            // the longest wrapped line is ≤ innerW, so right-edge fits;
            // but the subtitle's HEIGHT extends below the node, and a
            // section that's tight on vertical space will see it overflow.
            // We log on bottom overflow (sections auto-grow); we reject
            // on right overflow (the wrap should always make this safe).
            if (activeSidNode) {
              const sectionHeader = state.elements.find((e) => {
                const cd = e.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string } | undefined;
                return cd?.fathomKind === 'wb-section' && cd?.isHeader === true && cd?.sectionId === activeSidNode;
              });
              if (sectionHeader) {
                const sx = (sectionHeader as { x?: number }).x;
                const sw = (sectionHeader as { width?: number }).width;
                if (typeof sx === 'number' && typeof sw === 'number') {
                  const SECTION_PAD = 30;
                  const sectionRight = sx + sw - SECTION_PAD;
                  // Longest wrapped line width:
                  const longestQLine = Math.max(...lines.map((l) => l.length), 1);
                  const qPredictedW = Math.ceil(longestQLine * NODE_QUESTION_CHAR_W);
                  const qRight = args.x + NODE_QUESTION_PAD_X + qPredictedW;
                  if (qRight > sectionRight + 1) {
                    const overflowPx = Math.ceil(qRight - sectionRight);
                    const maxCharsPerLine = Math.max(1, Math.floor((sectionRight - args.x - NODE_QUESTION_PAD_X) / NODE_QUESTION_CHAR_W));
                    return err(
                      `create_node_with_fitted_text: question subtitle "→ ${rawQ.slice(0, 40)}${rawQ.length > 40 ? '…' : ''}" ` +
                        `for node '${label}' would overflow section '${sectionHeader.id ?? '?'}' right edge by ${overflowPx}px ` +
                        `(longest wrapped line is ${longestQLine} chars × ${NODE_QUESTION_CHAR_W}px/char ≈ ${qPredictedW}px wide; ` +
                        `placed at x=${args.x + NODE_QUESTION_PAD_X} so right edge is ${qRight}px; ` +
                        `section right edge minus ${SECTION_PAD}px padding is ${sectionRight}px). ` +
                        `Fix: shorten question to ≤${maxCharsPerLine} chars per line, ` +
                        `OR move the node leftward so x ≤ ${Math.floor(sectionRight - qPredictedW - NODE_QUESTION_PAD_X)}, ` +
                        `OR drop the question if the node doesn't strictly need one (axis endpoints, decoration).`,
                    );
                  }
                }
              }
            }
            // Round-12a A2-symmetric: when emitting the wb-node-question,
            // also check whether its bbox crosses any existing arrow's
            // path. The arrow-path-vs-text check in connect_nodes is
            // emission-order-dependent — it only catches the case where
            // the text exists when the arrow is drawn. The reverse
            // (arrow exists when text emits) was uncaught and was the
            // root of the round-11 3 arrow-path-vs-question crossings.
            // Reject the node create_call if its question would cross
            // an existing arrow polyline.
            const questionBox = {
              xMin: args.x + NODE_QUESTION_PAD_X,
              yMin: args.y + h + NODE_QUESTION_GAP_Y,
              xMax: args.x + NODE_QUESTION_PAD_X + innerW,
              yMax: args.y + h + NODE_QUESTION_GAP_Y + qHeight,
            };
            const segCrossesBox = (
              p0: { x: number; y: number },
              p1: { x: number; y: number },
              b: { xMin: number; yMin: number; xMax: number; yMax: number },
            ): boolean => {
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
              for (let i = 0; i < 8; i += 1) {
                if ((c0 | c1) === 0) return true;
                if ((c0 & c1) !== 0) return false;
                const cOut = c0 !== 0 ? c0 : c1;
                let x = 0, y = 0;
                if (cOut & 8) { x = q0.x + ((q1.x - q0.x) * (b.yMax - q0.y)) / (q1.y - q0.y); y = b.yMax; }
                else if (cOut & 4) { x = q0.x + ((q1.x - q0.x) * (b.yMin - q0.y)) / (q1.y - q0.y); y = b.yMin; }
                else if (cOut & 2) { y = q0.y + ((q1.y - q0.y) * (b.xMax - q0.x)) / (q1.x - q0.x); x = b.xMax; }
                else { y = q0.y + ((q1.y - q0.y) * (b.xMin - q0.x)) / (q1.x - q0.x); x = b.xMin; }
                if (cOut === c0) { q0 = { x, y }; c0 = code(q0); }
                else { q1 = { x, y }; c1 = code(q1); }
              }
              return false;
            };
            const arrowCrossings: Array<{ arrowId: string; from: string; to: string }> = [];
            for (const arr of state.elements) {
              if (arr.type !== 'arrow') continue;
              const cdArr = arr.customData as { fathomKind?: string } | undefined;
              if (cdArr?.fathomKind !== 'wb-edge') continue;
              const fromBinding = (arr as { startBinding?: { elementId?: string } }).startBinding;
              const endBinding = (arr as { endBinding?: { elementId?: string } }).endBinding;
              const fromId = fromBinding?.elementId ?? '?';
              const toId = endBinding?.elementId ?? '?';
              // Skip arrows whose endpoint IS this node — its own arrows
              // naturally exit/enter near its own question subtitle.
              if (fromId === rectId || toId === rectId) continue;
              const ax = (arr as { x?: number }).x ?? 0;
              const ay = (arr as { y?: number }).y ?? 0;
              const pts = (arr as { points?: Array<[number, number]> }).points ?? [];
              if (pts.length < 2) continue;
              // Build absolute-coordinate polyline.
              const poly = pts.map(([px, py]) => ({ x: ax + px, y: ay + py }));
              for (let i = 0; i < poly.length - 1; i += 1) {
                if (segCrossesBox(poly[i], poly[i + 1], questionBox)) {
                  arrowCrossings.push({ arrowId: arr.id ?? '?', from: fromId, to: toId });
                  break;
                }
              }
            }
            if (arrowCrossings.length > 0) {
              const list = arrowCrossings
                .map((c) => `arrow ${c.arrowId} (${c.from}→${c.to})`)
                .join(', ');
              return err(
                `create_node_with_fitted_text: emitting node '${label}' would place its question subtitle ` +
                  `at bbox (${questionBox.xMin},${questionBox.yMin})–(${questionBox.xMax},${questionBox.yMax}) ` +
                  `which is crossed by ${arrowCrossings.length} existing arrow(s): ${list}. ` +
                  `Either move the node (shift y to a row not crossed by these arrows), ` +
                  `OR re-route the existing arrow(s) by re-calling connect_nodes with routePoints to clear this y-band, ` +
                  `OR drop the question on this node if it can do without one.`,
              );
            }
            const qId = nextId(state, 'question');
            pushElements(state, {
              type: 'text',
              id: qId,
              x: args.x + NODE_QUESTION_PAD_X,
              y: args.y + h + NODE_QUESTION_GAP_Y,
              width: innerW,
              height: qHeight,
              text: qText,
              originalText: qText,
              autoResize: false,
              fontSize: NODE_QUESTION_FONTSIZE,
              fontFamily: FONT_FAMILY_EXCALIFONT,
              textAlign: 'left',
              verticalAlign: 'top',
              // Slightly muted color so the question reads as supporting
              // text, not as a competing label.
              strokeColor: '#5a4a3a',
              containerId: null,
              customData: {
                fathomKind: 'wb-node-question',
                nodeId: rectId,
                level: state.meta.level,
              },
            } as SceneText);
            // Bump the running bottom so the next emission stacks below
            // the question, not below the rect alone.
            state.lastBottomY = Math.max(
              state.lastBottomY,
              args.y + h + NODE_QUESTION_GAP_Y + qHeight,
            );
          }
          return ok(
            JSON.stringify({
              node_id: rectId,
              actual_w: w,
              actual_h: h,
              right_edge_x: args.x + w,
              suggested_next_x: args.x + w + 120,
            }),
          );
        },
      ),
      tool(
        'connect_nodes',
        'Create an arrow with start/end bindings. ' +
          'If `label` is provided, the wrapper computes the label\'s bbox at the arrow midpoint and ' +
          'REJECTS the call when that bbox would collide with any existing element (per CLAUDE.md §8: ' +
          'tools enforce constraints; prompts only guide intent). On rejection the error names the ' +
          'colliding element and suggests `labelOffset: {dx, dy}` shifts the wrapper has already tested ' +
          'as collision-free, OR asks the agent to shorten the label.',
        {
          from_id: z.string(),
          to_id: z.string(),
          label: z.string().max(24).optional(),
          /** Round-9 user-critique fix: if the auto-placed label collides
           * with an existing element, agents may pass a {dx, dy} offset
           * (in pixels, relative to the arrow midpoint) to nudge the
           * label clear. The wrapper re-runs the collision check at the
           * offset position; persistent collision still rejects. */
          labelOffset: z
            .object({ dx: z.number(), dy: z.number() })
            .optional(),
          /** Round-10 user-critique fix: if the natural straight-line
           * arrow path crosses a text element between the endpoints,
           * agents may pass intermediate waypoints to route around it.
           * Each {x, y} is a point in scene coordinates; the arrow becomes
           * a polyline through start → waypoints[0] → waypoints[1] → ... → end.
           * The wrapper re-runs the path-vs-text crossing check on the
           * routed polyline; persistent crossing still rejects with a
           * suggested route. */
          routePoints: z
            .array(z.object({ x: z.number(), y: z.number() }))
            .max(8)
            .optional(),
        },
        async (args) => {
          const from = state.elements.find((e) => e.id === args.from_id);
          const to = state.elements.find((e) => e.id === args.to_id);
          if (!from || from.type !== 'rectangle') return err(`from_id '${args.from_id}' is not a rectangle.`);
          if (!to || to.type !== 'rectangle') return err(`to_id '${args.to_id}' is not a rectangle.`);
          const arrowId = nextId(state, 'arrow');
          const startX = from.x + from.width;
          const startY = from.y + from.height / 2;
          const endX = to.x;
          const endY = to.y + to.height / 2;
          // Round-9: collision check on the label's predicted bbox.
          // Computed BEFORE pushing the arrow so the rejection path
          // doesn't leave a stub arrow in state. Per CLAUDE.md §8.
          if (typeof args.label === 'string' && args.label.length > 0) {
            const ARROW_LABEL_FONTSIZE = 11;
            const ARROW_LABEL_CHAR_W = 7; // Helvetica @ 11px ≈ 7 px/char
            const ARROW_LABEL_LINE_H = Math.ceil(ARROW_LABEL_FONTSIZE * 1.4);
            const ARROW_LABEL_PADDING = 4; // tolerance for "near" collisions
            const labelText = args.label.slice(0, 24);
            const labelW = labelText.length * ARROW_LABEL_CHAR_W;
            const labelH = ARROW_LABEL_LINE_H + 4;
            // Anchor: arrow midpoint + optional caller offset, label bbox
            // is centred on that anchor (Excalidraw's default for arrow labels).
            const midX = (startX + endX) / 2 + (args.labelOffset?.dx ?? 0);
            const midY = (startY + endY) / 2 + (args.labelOffset?.dy ?? 0);
            const labelBox = {
              xMin: midX - labelW / 2 - ARROW_LABEL_PADDING,
              xMax: midX + labelW / 2 + ARROW_LABEL_PADDING,
              yMin: midY - labelH / 2 - ARROW_LABEL_PADDING,
              yMax: midY + labelH / 2 + ARROW_LABEL_PADDING,
            };
            // Iterate every existing element with a bbox; collision = true
            // if interior pixels overlap. Endpoints (from/to) excluded —
            // the label is *expected* to sit near them.
            const collided: Array<{ id: string; kind: string; text: string; bb: { xMin: number; yMin: number; xMax: number; yMax: number } }> = [];
            for (const el of state.elements) {
              if (!el.id) continue;
              if (el.id === args.from_id || el.id === args.to_id) continue;
              const fk = (el.customData as { fathomKind?: string } | undefined)?.fathomKind;
              if (!fk) continue;
              // Skip pseudo-elements (cameras) and zone backgrounds (those
              // are visual tints, not collision surfaces).
              if (fk === 'wb-camera' || fk === 'wb-zone' || fk === 'wb-zoneplate') continue;
              const ex = (el as { x?: number }).x;
              const ey = (el as { y?: number }).y;
              const ew = (el as { width?: number }).width;
              const eh = (el as { height?: number }).height;
              if (typeof ex !== 'number' || typeof ey !== 'number') continue;
              if (typeof ew !== 'number' || typeof eh !== 'number') continue;
              const elBox = { xMin: ex, yMin: ey, xMax: ex + ew, yMax: ey + eh };
              const overlaps =
                labelBox.xMin < elBox.xMax &&
                labelBox.xMax > elBox.xMin &&
                labelBox.yMin < elBox.yMax &&
                labelBox.yMax > elBox.yMin;
              if (!overlaps) continue;
              const elText =
                ((el as { label?: { text?: string } }).label?.text)
                  ?? ((el as { text?: string }).text)
                  ?? '';
              collided.push({ id: el.id, kind: fk, text: String(elText).slice(0, 40), bb: elBox });
            }
            if (collided.length > 0) {
              // Try a small grid-search of offsets to suggest a free spot.
              const candidateOffsets: Array<{ dx: number; dy: number }> = [
                { dx: 0,  dy: -28 }, { dx: 0,  dy: 28 },
                { dx: -28, dy: 0 }, { dx: 28, dy: 0 },
                { dx: 0,  dy: -56 }, { dx: 0,  dy: 56 },
                { dx: -56, dy: 0 }, { dx: 56, dy: 0 },
                { dx: -28, dy: -28 }, { dx: 28, dy: -28 },
                { dx: -28, dy: 28 }, { dx: 28, dy: 28 },
              ];
              let suggestion: { dx: number; dy: number } | null = null;
              const baseMidX = (startX + endX) / 2;
              const baseMidY = (startY + endY) / 2;
              for (const cand of candidateOffsets) {
                const cMidX = baseMidX + cand.dx;
                const cMidY = baseMidY + cand.dy;
                const cBox = {
                  xMin: cMidX - labelW / 2 - ARROW_LABEL_PADDING,
                  xMax: cMidX + labelW / 2 + ARROW_LABEL_PADDING,
                  yMin: cMidY - labelH / 2 - ARROW_LABEL_PADDING,
                  yMax: cMidY + labelH / 2 + ARROW_LABEL_PADDING,
                };
                let free = true;
                for (const c of collided) {
                  if (
                    cBox.xMin < c.bb.xMax &&
                    cBox.xMax > c.bb.xMin &&
                    cBox.yMin < c.bb.yMax &&
                    cBox.yMax > c.bb.yMin
                  ) { free = false; break; }
                }
                if (!free) continue;
                // Also re-check against ALL non-endpoint elements (not just
                // the originally-colliding ones) to make sure the suggestion
                // doesn't trade one collision for another.
                let trulyFree = true;
                for (const el of state.elements) {
                  if (!el.id) continue;
                  if (el.id === args.from_id || el.id === args.to_id) continue;
                  const fk = (el.customData as { fathomKind?: string } | undefined)?.fathomKind;
                  if (!fk || fk === 'wb-camera' || fk === 'wb-zone' || fk === 'wb-zoneplate') continue;
                  const ex = (el as { x?: number }).x;
                  const ey = (el as { y?: number }).y;
                  const ew = (el as { width?: number }).width;
                  const eh = (el as { height?: number }).height;
                  if (typeof ex !== 'number' || typeof ey !== 'number') continue;
                  if (typeof ew !== 'number' || typeof eh !== 'number') continue;
                  if (
                    cBox.xMin < ex + ew &&
                    cBox.xMax > ex &&
                    cBox.yMin < ey + eh &&
                    cBox.yMax > ey
                  ) { trulyFree = false; break; }
                }
                if (trulyFree) { suggestion = cand; break; }
              }
              const collisionList = collided
                .map((c) => `${c.id} (${c.kind}, "${c.text}")`)
                .join(', ');
              const suggestionStr = suggestion
                ? `Try \`labelOffset: { dx: ${suggestion.dx}, dy: ${suggestion.dy} }\` — wrapper verified that offset is collision-free.`
                : `No nearby offset was free; shorten label to ≤${Math.max(2, Math.floor(labelText.length / 2))} chars OR re-route via different from/to nodes.`;
              return err(
                `connect_nodes: arrow label "${labelText}" at midpoint (${Math.round(midX)},${Math.round(midY)}) ` +
                  `size ~${Math.round(labelW)}×${Math.round(labelH)}px collides with ${collided.length} element(s): ${collisionList}. ` +
                  suggestionStr,
              );
            }
          }

          // Round-10 user critique 2026-04-27 (CLAUDE.md §8): "arrow from
          // SLAT Flow + RVC → 3D mesh crosses text below." Tool-layer
          // rejection: compute the arrow's polyline (start → routePoints[]
          // → end) and check each segment against every text element's
          // bbox. If any segment crosses a text bbox, reject with a
          // precise diagnostic and a suggested routePoints[] that avoids
          // the crossing.
          //
          // Segment-vs-rect intersection: standard Liang-Barsky shape —
          // for each segment, check against rect via Cohen-Sutherland-
          // style outcode test. Endpoints belonging to the segment's
          // own start/end nodes are excluded (the arrow is *expected*
          // to graze its endpoint nodes).
          const polyline: Array<{ x: number; y: number }> = [
            { x: startX, y: startY },
            ...((args.routePoints ?? []).map((p) => ({ x: p.x, y: p.y }))),
            { x: endX, y: endY },
          ];
          // Helper: does line segment (p0→p1) cross axis-aligned rect b?
          const segmentCrossesRect = (
            p0: { x: number; y: number },
            p1: { x: number; y: number },
            b: { xMin: number; yMin: number; xMax: number; yMax: number },
          ): boolean => {
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
            for (let i = 0; i < 8; i += 1) {
              if ((c0 | c1) === 0) return true;
              if ((c0 & c1) !== 0) return false;
              const cOut = c0 !== 0 ? c0 : c1;
              let x = 0, y = 0;
              if (cOut & 8) { x = q0.x + ((q1.x - q0.x) * (b.yMax - q0.y)) / (q1.y - q0.y); y = b.yMax; }
              else if (cOut & 4) { x = q0.x + ((q1.x - q0.x) * (b.yMin - q0.y)) / (q1.y - q0.y); y = b.yMin; }
              else if (cOut & 2) { y = q0.y + ((q1.y - q0.y) * (b.xMax - q0.x)) / (q1.x - q0.x); x = b.xMax; }
              else { y = q0.y + ((q1.y - q0.y) * (b.xMin - q0.x)) / (q1.x - q0.x); x = b.xMin; }
              if (cOut === c0) { q0 = { x, y }; c0 = code(q0); }
              else { q1 = { x, y }; c1 = code(q1); }
            }
            return false;
          };
          // Collect text bboxes that count as "obstacles" for the path —
          // skip text bound to the arrow's start/end nodes (those are
          // labels of the endpoints, expected to be near the arrow).
          const textObstacles: Array<{ id: string; kind: string; text: string; bb: { xMin: number; yMin: number; xMax: number; yMax: number } }> = [];
          for (const el of state.elements) {
            if (el.type !== 'text') continue;
            const cd = el.customData as { fathomKind?: string; nodeId?: string } | undefined;
            const fk = cd?.fathomKind;
            if (!fk) continue;
            // Free-floating, narrative-bearing text. Skip drill glyphs,
            // citations (decorative), zone-label-plates (stylistic).
            if (fk === 'wb-drill-glyph' || fk === 'wb-citation') continue;
            // If this text is bound to the arrow's start or end node
            // (e.g. wb-node-question subtitle of the from/to node), skip —
            // the arrow naturally exits/enters near those.
            if (cd?.nodeId === args.from_id || cd?.nodeId === args.to_id) continue;
            const ex = (el as { x?: number }).x;
            const ey = (el as { y?: number }).y;
            const ew = (el as { width?: number }).width;
            const eh = (el as { height?: number }).height;
            if (typeof ex !== 'number' || typeof ey !== 'number') continue;
            if (typeof ew !== 'number' || typeof eh !== 'number') continue;
            const bb = { xMin: ex, yMin: ey, xMax: ex + ew, yMax: ey + eh };
            const text = (el as { text?: string }).text ?? '';
            textObstacles.push({ id: el.id ?? '?', kind: fk, text: text.slice(0, 40), bb });
          }
          // Walk each segment of the polyline; record any text crossings.
          const crossings: Array<{ segIdx: number; obstacle: typeof textObstacles[number] }> = [];
          for (let i = 0; i < polyline.length - 1; i += 1) {
            const p0 = polyline[i];
            const p1 = polyline[i + 1];
            for (const o of textObstacles) {
              if (segmentCrossesRect(p0, p1, o.bb)) {
                crossings.push({ segIdx: i, obstacle: o });
              }
            }
          }
          if (crossings.length > 0) {
            // Suggest a routePoints[] that avoids the obstacles. Strategy:
            // pick a single waypoint at the arrow midpoint, vertically
            // shifted above-or-below by enough px to clear every obstacle.
            // 12-position grid search around the midpoint.
            const baseMidX = (startX + endX) / 2;
            const baseMidY = (startY + endY) / 2;
            const offsets: Array<{ dx: number; dy: number }> = [
              { dx: 0,  dy: -60 }, { dx: 0,  dy: 60 },
              { dx: 0,  dy: -100 }, { dx: 0,  dy: 100 },
              { dx: -80, dy: -40 }, { dx: 80, dy: -40 },
              { dx: -80, dy: 40 }, { dx: 80, dy: 40 },
              { dx: 0,  dy: -160 }, { dx: 0,  dy: 160 },
              { dx: -120, dy: 0 }, { dx: 120, dy: 0 },
            ];
            let suggestedRoute: Array<{ x: number; y: number }> | null = null;
            for (const off of offsets) {
              const cand: Array<{ x: number; y: number }> = [
                { x: startX, y: startY },
                { x: baseMidX + off.dx, y: baseMidY + off.dy },
                { x: endX, y: endY },
              ];
              let free = true;
              for (let i = 0; i < cand.length - 1 && free; i += 1) {
                for (const o of textObstacles) {
                  if (segmentCrossesRect(cand[i], cand[i + 1], o.bb)) { free = false; break; }
                }
              }
              if (free) {
                suggestedRoute = [{ x: Math.round(cand[1].x), y: Math.round(cand[1].y) }];
                break;
              }
            }
            const crossingList = crossings
              .map((c) => `seg ${c.segIdx} crosses ${c.obstacle.id} (${c.obstacle.kind}, "${c.obstacle.text}") at bbox (${Math.round(c.obstacle.bb.xMin)},${Math.round(c.obstacle.bb.yMin)})–(${Math.round(c.obstacle.bb.xMax)},${Math.round(c.obstacle.bb.yMax)})`)
              .join('; ');
            const routeSuggestion = suggestedRoute
              ? `Try \`routePoints: [{x: ${suggestedRoute[0].x}, y: ${suggestedRoute[0].y}}]\` — wrapper verified that route is text-free.`
              : `No nearby waypoint cleared all obstacles; consider moving the colliding text element OR routing manually with multiple waypoints.`;
            return err(
              `connect_nodes: arrow path from ${args.from_id} → ${args.to_id} via polyline ` +
                `[${polyline.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' → ')}] ` +
                `crosses ${crossings.length} text element(s): ${crossingList}. ` +
                routeSuggestion,
            );
          }
          (from.boundElements as Array<{ id: string; type: 'text' | 'arrow' }>).push({
            id: arrowId,
            type: 'arrow',
          });
          (to.boundElements as Array<{ id: string; type: 'text' | 'arrow' }>).push({
            id: arrowId,
            type: 'arrow',
          });
          // Polyline points = start (always (0,0) relative to arrow.x/y),
          // any routePoints (relative to start), then end (relative to start).
          const arrowPoints: Array<[number, number]> = [[0, 0]];
          for (const rp of args.routePoints ?? []) {
            arrowPoints.push([rp.x - startX, rp.y - startY]);
          }
          arrowPoints.push([endX - startX, endY - startY]);
          pushElements(state, {
            type: 'arrow',
            id: arrowId,
            x: startX,
            y: startY,
            points: arrowPoints,
            strokeColor: '#1a1614',
            strokeWidth: 1.2,
            roughness: 1,
            startBinding: { elementId: from.id, focus: 0, gap: 1 },
            endBinding: { elementId: to.id, focus: 0, gap: 1 },
            label: args.label
              ? {
                  text: args.label.slice(0, 24),
                  fontSize: 11,
                  fontFamily: FONT_FAMILY_HELVETICA,
                  strokeColor: '#5a4a3a',
                }
              : undefined,
            customData: {
              fathomKind: 'wb-edge',
              level: state.meta.level,
              parentId: state.meta.parent,
            },
          });
          return ok(JSON.stringify({ arrow_id: arrowId }));
        },
      ),
      tool(
        'describe_scene',
        'Inspect scene state.',
        {},
        async () => {
          const counts: Record<string, number> = {};
          for (const e of state.elements) counts[e.type] = (counts[e.type] ?? 0) + 1;
          const nodes = state.elements.filter(
            (e): e is SceneRect =>
              e.type === 'rectangle' &&
              ((e.customData as { fathomKind?: string } | undefined)?.fathomKind ?? '') === 'wb-node',
          );
          const arrows = state.elements.filter((e): e is SceneArrow => e.type === 'arrow');
          const allIds = new Set(state.elements.map((e) => e.id));
          const brokenT: string[] = [];
          for (const e of state.elements) {
            if (e.type === 'text' && e.containerId && !allIds.has(e.containerId)) {
              brokenT.push(`text ${e.id} → ${e.containerId} MISSING`);
            }
          }
          const brokenA: string[] = [];
          for (const a of arrows) {
            if (a.startBinding && !allIds.has(a.startBinding.elementId)) {
              brokenA.push(`arrow ${a.id} startBinding MISSING`);
            }
            if (a.endBinding && !allIds.has(a.endBinding.elementId)) {
              brokenA.push(`arrow ${a.id} endBinding MISSING`);
            }
          }
          const nodeLines = nodes.map((n) => {
            const cd = (n.customData ?? {}) as Record<string, unknown>;
            return `  ${n.id} pos=(${Math.round(n.x)},${Math.round(n.y)}) size=${Math.round(n.width)}x${Math.round(n.height)} kind=${cd.kind ?? '?'} drillable=${cd.drillable === true}`;
          });
          const overflowFlag = nodes.length > 5
            ? `\nWARNING: ${nodes.length} nodes — exceeds the ≤5 ceiling.`
            : '';
          const lines = [
            `Scene level=${state.meta.level}${state.meta.parent ? ` parent=${state.meta.parent}` : ''}`,
            `counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            `nodes: ${nodes.length} / 5`,
            ...nodeLines,
            `arrows: ${arrows.length}`,
            brokenT.length === 0 ? `text bindings: all OK` : `text bindings: ${brokenT.length} BROKEN\n  ${brokenT.join('\n  ')}`,
            brokenA.length === 0 ? `arrow bindings: all OK` : `arrow bindings: ${brokenA.length} BROKEN\n  ${brokenA.join('\n  ')}`,
            overflowFlag,
          ].filter(Boolean);
          return ok(lines.join('\n'));
        },
      ),
      tool('export_scene', 'Finalise the scene as Excalidraw JSON.', {}, async () =>
        ok(
          JSON.stringify({
            type: 'excalidraw',
            version: 2,
            source: 'fathom-whiteboard',
            // v3.2.1 — strip wb-camera pseudo-elements before persistence.
            // They're authoring metadata (lecturer-narration intent), not
            // visual content; AC-NO-PSEUDO catches them if they leak.
            elements: stripPseudoElements(state.elements),
            appState: { viewBackgroundColor: '#fafaf7' },
            files: {},
          }),
        ),
      ),
      tool('clear_scene', 'Wipe scene state.', {}, async () => {
        state.elements.length = 0;
        state.counter = 0;
        state.activeSectionId = undefined;
        state.lastBottomY = 0;
        return ok('cleared');
      }),
      // v3.2.1 — five new primitives per critic-rubric. Together they
      // unlock the multi-section / multi-modality compositions the
      // single-row create_node_with_fitted_text + connect_nodes loop
      // can't express.
      tool(
        'create_section',
        'Open a new narrative section. Every whiteboard is a vertical stack of sections; ' +
          'each section is one self-contained explanation (architecture / math / key idea / etc.). ' +
          'Call this BEFORE the section\'s content. Subsequent create_* calls auto-tag with the section id ' +
          'until the next create_section call. Sections stack at bottom_of_canvas + 80px automatically. ' +
          'Section title becomes the section header bar; subtitle is optional supporting text below.',
        {
          // v3.2.1 patch (critic round 1): hard-cap section title at 60 chars
          // and subtitle at 80. The renderer is autoResize:false at fontSize=22
          // for titles and silently clips strings wider than the section row
          // (1480 px ≈ 95 chars at fs=22). The agent has been emitting 75-char
          // titles that visibly truncate mid-word ("...as a veloc"). Tool-level
          // rejection forces split into title + subtitle.
          title: z
            .string()
            .min(1)
            .max(60, 'Section title must be ≤ 60 chars (renderer clips longer strings mid-word). If your title is longer, split it: keep the first clause as title, move the rest into subtitle.'),
          subtitle: z
            .string()
            .max(80, 'Section subtitle must be ≤ 80 chars (same reason). If you need more text, use create_text inside the section instead.')
            .optional(),
          provenance: z.enum(['paper', 'drill', 'chat']).optional(),
        },
        async (args) => {
          const title = args.title;
          const subtitle = args.subtitle;
          const provenance = args.provenance ?? 'paper';
          // Round-4 fix (critic ask): if the active section is EMPTY of
          // narrative content (only its header + subheader exist), the
          // agent is correcting a typo'd / paraphrased section title — not
          // adding a new section. Drop the empty stub before creating the
          // replacement, so we don't leave a phantom header behind that
          // owns hardcoded coordinates the agent will then collide with.
          if (state.activeSectionId) {
            const activeSid = state.activeSectionId;
            const stubChildren = state.elements.filter((e) => {
              const cd = e.customData as { sectionId?: string } | undefined;
              return cd?.sectionId === activeSid;
            });
            const onlyHeaderStub = stubChildren.every((e) => {
              const cd = e.customData as { fathomKind?: string } | undefined;
              return cd?.fathomKind === 'wb-section';
            });
            if (onlyHeaderStub && stubChildren.length > 0) {
              state.elements = state.elements.filter((e) => {
                const cd = e.customData as { sectionId?: string } | undefined;
                return cd?.sectionId !== activeSid;
              });
              state.activeSectionId = undefined;
              // Reset lastBottomY so the new section can start at the same
              // y the dropped stub would have started — avoid leaving a
              // gap. Recompute from the highest yMax in the remaining
              // wb-section headers (or back to 0 if none).
              const remainingSectionBottoms = state.elements
                .filter((e) => {
                  const cd = e.customData as { fathomKind?: string; isHeader?: boolean } | undefined;
                  return cd?.fathomKind === 'wb-section' && cd?.isHeader === true;
                })
                .map((e) => (e.y ?? 0) + 50);
              state.lastBottomY = remainingSectionBottoms.length > 0 ? Math.max(...remainingSectionBottoms) : 0;
            }
          }
          // Count only the HEADER wb-section element per section (not the
          // subtitle, which also has fathomKind='wb-section'). The bug
          // pre-fix: each create_section pushed a header AND a subheader,
          // both with fathomKind='wb-section'. The unfiltered count of
          // wb-section elements ran 0 → 2 → 4 → 6, producing
          // sectionNumber=1, 3, 5 instead of 1, 2, 3 (critic round 3 FAIL).
          // Restricting the count to headers only — sectionId is unique
          // per call so this naturally yields 1, 2, 3.
          const sectionNumber = state.elements.filter((e) => {
            const cd = e.customData as { fathomKind?: string; isHeader?: boolean } | undefined;
            return cd?.fathomKind === 'wb-section' && cd?.isHeader === true;
          }).length + 1;
          const sectionId = nextId(state, 'section');
          // Stack below current bottom; first section starts at y=140 to
          // leave room for a paper-level title bar.
          const yStart = state.lastBottomY > 0 ? state.lastBottomY + 80 : 140;
          // Canvas-wide section span. The frame's height grows as content
          // is added; we seed it at 60 (just header) and the renderer's
          // hydrate path reads sectionId off children to know what
          // belongs inside.
          const SECTION_X = 60;
          const SECTION_W = 1480;
          const HEADER_H = subtitle ? 70 : 50;
          // The section header is rendered as a free-text element rather
          // than a frame border so it scrolls naturally + doesn't fight
          // Excalidraw's frame z-order semantics. The "section" identity
          // lives on customData.sectionId stamped on every child.
          const headerId = nextId(state, 'sechdr');
          state.elements.push({
            type: 'text',
            id: headerId,
            x: SECTION_X,
            y: yStart,
            width: SECTION_W,
            height: 30,
            text: `${sectionNumber}. ${title}`,
            originalText: `${sectionNumber}. ${title}`,
            autoResize: false,
            fontSize: 22,
            fontFamily: FONT_FAMILY_EXCALIFONT,
            textAlign: 'left',
            verticalAlign: 'top',
            strokeColor: '#1a1614',
            containerId: null,
            customData: {
              fathomKind: 'wb-section',
              sectionId,
              sectionNumber,
              provenance,
              title,
              subtitle,
              isHeader: true,
            },
          } as SceneText);
          if (subtitle) {
            const subId = nextId(state, 'secsub');
            state.elements.push({
              type: 'text',
              id: subId,
              x: SECTION_X,
              y: yStart + 36,
              width: SECTION_W,
              height: 20,
              text: subtitle,
              originalText: subtitle,
              autoResize: false,
              fontSize: 14,
              fontFamily: FONT_FAMILY_HELVETICA,
              textAlign: 'left',
              verticalAlign: 'top',
              strokeColor: '#5a4a3a',
              containerId: null,
              customData: {
                fathomKind: 'wb-section',
                sectionId,
                isSubheader: true,
              },
            } as SceneText);
          }
          state.activeSectionId = sectionId;
          state.lastBottomY = yStart + HEADER_H;
          return ok(
            JSON.stringify({
              section_id: sectionId,
              section_number: sectionNumber,
              x: SECTION_X,
              y: yStart,
              width: SECTION_W,
              header_height: HEADER_H,
              content_y_start: yStart + HEADER_H + 10,
              note: `Subsequent create_* calls auto-tag with sectionId=${sectionId}. Call create_section again to start the next section.`,
            }),
          );
        },
      ),
      tool(
        'create_background_zone',
        'Drop a faint background zone (30% opacity tinted rectangle) to GROUP a set of related shapes inside a section. ' +
          'Per critic rule 1: "the first design move is to identify the 2-3 conceptual regions of the explanation and drop those as background zones." ' +
          'Color the zone by the role of the content it contains (input/process/output/math/noise/neutral). ' +
          'Add a `label` for the zone (INPUTS / PROCESS / OUTPUT / etc.). ' +
          'IMPORTANT: emit zones BEFORE their inner shapes so z-order keeps content on top. ' +
          'The renderer auto-positions the label as a small uppercase chip in the zone\'s top-left.',
        {
          role: z.enum(ROLES),
          // v3.2.1 patch (critic round 1): hard-cap zone labels at 16 chars
          // and reject parentheses. The renderer silently clips longer strings
          // ("GENERATE (COARSE-TO-FI..."), and the agent has been ignoring
          // the prompt-level rule. Tool-level rejection makes it un-skippable.
          label: z
            .string()
            .max(16, 'Zone label must be ≤ 16 chars; pick from the canonical vocabulary in PASS2_SYSTEM (INPUTS / PROCESS / OUTPUT / RECONSTRUCT / GENERATE / etc.). Move qualifications like "(coarse-to-fine)" into the section subtitle or a free annotation INSIDE the zone.')
            .refine((s) => !/[()]/.test(s), {
              message: 'Zone label must not contain parentheses. Move qualifications into the section subtitle or a free create_text annotation inside the zone.',
            })
            .optional(),
          x: z.number(),
          y: z.number(),
          // v3.2.1 patch: height min lowered 40→20 to support thin RHS
          // tint strips for math equations (critic rule 6 — "colored box
          // around the right-hand side"). Wider zones still cap at 1200.
          width: z.number().min(80).max(2000),
          height: z.number().min(20).max(1200),
        },
        async (args) => {
          // Round-10 user critique 2026-04-27 (CLAUDE.md §8): "INPUTS purple
          // zone partially overlaps multi-view blue zone." Reject zone-vs-zone
          // PARTIAL overlap at the wrapper. Strict containment (one zone
          // fully inside another) is allowed because zones may legitimately
          // nest. Strict separation is allowed. PARTIAL overlap obscures
          // content and is the user-flagged defect class.
          //
          // We only check against zones IN THE SAME SECTION (sectionId match)
          // — zones in different sections naturally sit at different y-bands
          // and the overlap-check would false-positive on adjacent sections.
          // Within a section, we check the new zone's bbox against every
          // existing wb-zone bbox.
          const newBox = {
            xMin: args.x,
            yMin: args.y,
            xMax: args.x + args.width,
            yMax: args.y + args.height,
          };
          const activeSid = state.activeSectionId;
          for (const el of state.elements) {
            if (el.type !== 'rectangle') continue;
            const cd = el.customData as { fathomKind?: string; purpose?: string; sectionId?: string; role?: string } | undefined;
            if (cd?.fathomKind !== 'wb-zone') continue;
            // Skip zone-label-plates (those sit inside zones by design).
            if (cd.purpose === 'zone-label-plate') continue;
            // Skip zones in other sections.
            if (activeSid && cd.sectionId && cd.sectionId !== activeSid) continue;
            const ex = (el as { x?: number }).x;
            const ey = (el as { y?: number }).y;
            const ew = (el as { width?: number }).width;
            const eh = (el as { height?: number }).height;
            if (typeof ex !== 'number' || typeof ey !== 'number') continue;
            if (typeof ew !== 'number' || typeof eh !== 'number') continue;
            const otherBox = { xMin: ex, yMin: ey, xMax: ex + ew, yMax: ey + eh };
            // Compute intersection.
            const ixMin = Math.max(newBox.xMin, otherBox.xMin);
            const ixMax = Math.min(newBox.xMax, otherBox.xMax);
            const iyMin = Math.max(newBox.yMin, otherBox.yMin);
            const iyMax = Math.min(newBox.yMax, otherBox.yMax);
            if (ixMax <= ixMin || iyMax <= iyMin) continue; // disjoint, allowed
            const overlapArea = (ixMax - ixMin) * (iyMax - iyMin);
            const newArea = (newBox.xMax - newBox.xMin) * (newBox.yMax - newBox.yMin);
            const otherArea = (otherBox.xMax - otherBox.xMin) * (otherBox.yMax - otherBox.yMin);
            // Strict containment check: new fully inside other, or other fully inside new.
            const newInsideOther =
              newBox.xMin >= otherBox.xMin && newBox.xMax <= otherBox.xMax &&
              newBox.yMin >= otherBox.yMin && newBox.yMax <= otherBox.yMax;
            const otherInsideNew =
              otherBox.xMin >= newBox.xMin && otherBox.xMax <= newBox.xMax &&
              otherBox.yMin >= newBox.yMin && otherBox.yMax <= newBox.yMax;
            if (newInsideOther || otherInsideNew) continue; // nested, allowed
            // Otherwise it's partial overlap — reject.
            const otherLabel =
              ((el as { label?: { text?: string } }).label?.text)
                ?? cd.role
                ?? (el.id ?? 'zone');
            // Suggest a non-overlap x position: shift right past the other's right edge.
            const suggestedX = Math.ceil(otherBox.xMax + 30);
            return err(
              `create_background_zone: new zone '${args.label ?? args.role ?? 'zone'}' bbox ` +
                `(${args.x},${args.y})–(${newBox.xMax},${newBox.yMax}) partially overlaps existing zone ` +
                `'${otherLabel}' (${el.id ?? '?'}) bbox (${ex},${ey})–(${otherBox.xMax},${otherBox.yMax}) ` +
                `by ${Math.round(overlapArea)} px² (other zone area ${Math.round(otherArea)} px², new zone area ${Math.round(newArea)} px²). ` +
                `Zones must EITHER fully contain (nest) OR fully separate — partial overlap obscures content. ` +
                `Suggested non-overlap position: x=${suggestedX} (shift right past the other zone's right edge with 30px gap).`,
            );
          }
          const pal = rolePalette(args.role);
          const zoneId = nextId(state, 'zone');
          pushElements(state, {
            type: 'rectangle',
            id: zoneId,
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
            strokeColor: 'transparent',
            backgroundColor: pal.zoneFill,
            strokeWidth: 0,
            strokeStyle: 'solid',
            roundness: { type: 3 },
            roughness: 0,
            fillStyle: 'solid',
            boundElements: [],
            customData: {
              fathomKind: 'wb-zone',
              role: args.role,
              purpose: 'sub-zone',
              opacity: 30,
            },
            // Excalidraw reads opacity off the element directly (0-100).
            opacity: 30,
          } as unknown as SceneRect);
          if (args.label && args.label.trim().length > 0) {
            const lbl = args.label.trim().toUpperCase();
            // v3.2.1 critic round 1 fix — the prior `lbl.length * 7 + 4`
            // sizing was ~30% too narrow for Excalifont @ 11px UPPERCASE,
            // which has real char-width closer to 10 px (caps are wider
            // than mixed-case). The autoResize:false text was getting
            // silently clipped on the right ("INPUTS" → "EMPUTS" in
            // render). Bumped to 11 px/char on the text element + matching
            // 11 px/char on the plate for visual harmony. The plate
            // continues to clip at args.width - 20 so a too-long label
            // can't escape the parent zone.
            const LBL_CHAR_W = 11;
            const PLATE_PADDING = 16;
            const TEXT_PADDING = 12;
            const plateId = nextId(state, 'zoneplate');
            pushElements(state, {
              type: 'rectangle',
              id: plateId,
              x: args.x + 10,
              y: args.y + 8,
              width: Math.min(args.width - 20, lbl.length * LBL_CHAR_W + PLATE_PADDING),
              height: 20,
              strokeColor: 'transparent',
              backgroundColor: '#ffffff',
              strokeWidth: 0,
              strokeStyle: 'solid',
              roundness: { type: 3 },
              roughness: 0,
              fillStyle: 'solid',
              boundElements: [],
              customData: { fathomKind: 'wb-zone', purpose: 'zone-label-plate', sectionId: state.activeSectionId },
              opacity: 90,
            } as unknown as SceneRect);
            const lblId = nextId(state, 'zonelbl');
            pushElements(state, {
              type: 'text',
              id: lblId,
              x: args.x + 18,
              y: args.y + 11,
              width: Math.min(args.width - 36, lbl.length * LBL_CHAR_W + TEXT_PADDING),
              height: 14,
              text: lbl,
              originalText: lbl,
              autoResize: false,
              fontSize: 11,
              fontFamily: FONT_FAMILY_EXCALIFONT,
              textAlign: 'left',
              verticalAlign: 'top',
              strokeColor: '#5a4a3a',
              containerId: null,
              customData: { fathomKind: 'wb-zone-label', sectionId: state.activeSectionId },
            } as SceneText);
          }
          return ok(
            JSON.stringify({
              zone_id: zoneId,
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
              note: 'Place inner shapes AFTER this call so they render on top of the zone tint.',
            }),
          );
        },
      ),
      tool(
        'create_text',
        'Free-floating text — no container, no rectangle around it. For annotations, captions, equation lines, narrative prose, axis labels. ' +
          'Use fontFamily=5 (Excalifont, default) for prose; fontFamily=2 (JetBrains Mono) for equations; fontFamily=1 (Helvetica) for compact info. ' +
          'For math sections per critic rule 6: emit equations as create_text with fontFamily=2 (NO container shape around the formula).',
        {
          text: z.string().min(1).max(2000),
          x: z.number(),
          y: z.number(),
          width: z.number().min(40).max(2000),
          fontSize: z.number().min(8).max(48).optional(),
          fontFamily: z.enum(['excalifont', 'helvetica', 'mono']).optional(),
          color: z.string().optional(),
          align: z.enum(['left', 'center', 'right']).optional(),
          purpose: z.enum(['annotation', 'caption', 'equation', 'narrative', 'axisLabel', 'title']).optional(),
        },
        async (args) => {
          const fontSize = args.fontSize ?? 14;
          const fontFamily =
            args.fontFamily === 'mono' ? 2 : args.fontFamily === 'helvetica' ? 1 : FONT_FAMILY_EXCALIFONT;
          const align = args.align ?? 'left';
          // Round-12a/round-12b: AC-TEXT-WIDTH-FIT. Text must fit within
          // its container's inner width. Two-tier check:
          //   1. SECTION-FIT (the broad case, catches most real defects):
          //      if there's an active section, the text's longest line
          //      must fit within the section's right edge minus padding.
          //      This catches the round-11 visible failure: equation lines
          //      at fontSize=20 mono with 109+ chars overflowing the
          //      canvas by 270+px even though they technically fit within
          //      the element.width=1440 declared bbox.
          //   2. ZONE-FIT (the narrow case, catches text inside small
          //      tinted RHS zones): if anchor is INSIDE a wb-zone, also
          //      check against the zone's inner width.
          // ZONE_INNER_PAD per side; SECTION_PAD matches the rest of the
          // wrapper's section-bounds checks (30px) to keep error messages
          // consistent.
          const ZONE_INNER_PAD = 12;
          const SECTION_PAD = 30;
          // Per-char width estimate per fontFamily. Calibrations come from
          // empirical observation: Excalifont mixed-case ≈ 7.5 px/char at
          // fontSize=14; Helvetica similar; mono with unicode (λ, ·, ∂, ̂)
          // renders ~14 px/char at fontSize=14, NOT the 11 we used initially
          // — round-11 mono equations with fontSize=20 char_w=11 predicted
          // 1199px but rendered at ~1700px. Bump mono to 14 to be safe.
          const charWBase = fontFamily === 2 ? 14 : 7.5;
          const charW = (charWBase * fontSize) / 14;
          const longestLineChars = Math.max(
            ...args.text.split('\n').map((s) => s.length),
            1,
          );
          const predictedTextWidth = Math.ceil(longestLineChars * charW);
          // Tier 1: SECTION-FIT check (the broad catch).
          if (state.activeSectionId) {
            const sectionHeader = state.elements.find((e) => {
              const cd = e.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string } | undefined;
              return cd?.fathomKind === 'wb-section' && cd?.isHeader === true && cd?.sectionId === state.activeSectionId;
            });
            if (sectionHeader) {
              const sx = (sectionHeader as { x?: number }).x;
              const sw = (sectionHeader as { width?: number }).width;
              if (typeof sx === 'number' && typeof sw === 'number') {
                const sectionRight = sx + sw - SECTION_PAD;
                const textRight = args.x + predictedTextWidth;
                if (textRight > sectionRight + 1) {
                  const overflowPx = Math.ceil(textRight - sectionRight);
                  const availableW = Math.max(1, sectionRight - args.x);
                  const maxCharsPerLine = Math.max(1, Math.floor(availableW / charW));
                  return err(
                    `create_text: text "${args.text.slice(0, 40)}${args.text.length > 40 ? '…' : ''}" ` +
                      `at (${args.x},${args.y}) longest line is ${longestLineChars} chars at fontSize=${fontSize} ` +
                      `≈ ${predictedTextWidth}px wide; placed at x=${args.x} so right edge is ${args.x + predictedTextWidth}px ` +
                      `but section '${sectionHeader.id ?? '?'}' right edge minus ${SECTION_PAD}px padding is ${sectionRight}px ` +
                      `— text overflows by ${overflowPx}px. ` +
                      `Fix: insert \\n line breaks so the longest line is ≤ ${maxCharsPerLine} chars (this fontFamily renders ` +
                      `~${Math.ceil(charW)}px per char at fontSize=${fontSize}), ` +
                      `OR split the text into multiple stacked create_text calls (one per equation/concept), ` +
                      `OR reduce fontSize and re-budget, ` +
                      `OR move the anchor leftward so x ≤ ${Math.floor(sectionRight - predictedTextWidth)}.`,
                  );
                }
              }
            }
          }
          for (const el of state.elements) {
            if (el.type !== 'rectangle') continue;
            const cd = el.customData as { fathomKind?: string; purpose?: string; sectionId?: string; role?: string } | undefined;
            if (cd?.fathomKind !== 'wb-zone') continue;
            if (cd.purpose === 'zone-label-plate') continue;
            const zx = (el as { x?: number }).x;
            const zy = (el as { y?: number }).y;
            const zw = (el as { width?: number }).width;
            const zh = (el as { height?: number }).height;
            if (typeof zx !== 'number' || typeof zy !== 'number') continue;
            if (typeof zw !== 'number' || typeof zh !== 'number') continue;
            // Is the text's anchor inside this zone?
            const anchorInside =
              args.x >= zx && args.x <= zx + zw &&
              args.y >= zy && args.y <= zy + zh;
            if (!anchorInside) continue;
            // Available width inside the zone, from text anchor to zone right edge.
            const availableW = (zx + zw) - args.x - ZONE_INNER_PAD;
            if (predictedTextWidth > availableW) {
              const overflowPx = Math.ceil(predictedTextWidth - availableW);
              const maxCharsPerLine = Math.max(1, Math.floor(availableW / charW));
              const zoneLabel =
                ((el as { label?: { text?: string } }).label?.text)
                  ?? cd.role ?? (el.id ?? 'zone');
              return err(
                `create_text: text "${args.text.slice(0, 40)}${args.text.length > 40 ? '…' : ''}" ` +
                  `at (${args.x},${args.y}) longest line is ${longestLineChars} chars at fontSize=${fontSize} ` +
                  `≈ ${predictedTextWidth}px wide, but zone '${zoneLabel}' (${el.id ?? '?'}) at ` +
                  `(${zx},${zy})–(${zx + zw},${zy + zh}) only allows ${Math.max(0, Math.floor(availableW))}px ` +
                  `from the anchor to the zone right edge minus ${ZONE_INNER_PAD}px padding — text overflows by ${overflowPx}px. ` +
                  `Fix options: (a) insert \\n line breaks so the longest line is ≤ ${maxCharsPerLine} chars, ` +
                  `(b) split the text into multiple stacked create_text calls (one per equation/concept), ` +
                  `(c) widen the zone to at least width=${Math.ceil(predictedTextWidth + ZONE_INNER_PAD * 2)}, ` +
                  `(d) reduce fontSize.`,
              );
            }
          }
          // Estimate height: line count × line height. Wrap on \n only;
          // Excalidraw will hard-wrap to width otherwise.
          const lineCount = Math.max(1, args.text.split('\n').length);
          const lineH = Math.ceil(fontSize * 1.3);
          const height = Math.max(20, lineCount * lineH + 4);
          const textId = nextId(state, 'text');
          pushElements(state, {
            type: 'text',
            id: textId,
            x: args.x,
            y: args.y,
            width: args.width,
            height,
            text: args.text,
            originalText: args.text,
            autoResize: false,
            fontSize,
            fontFamily,
            textAlign: align,
            verticalAlign: 'top',
            strokeColor: args.color ?? '#1a1614',
            containerId: null,
            customData: {
              fathomKind: 'wb-text',
              purpose: args.purpose,
            },
          } as SceneText);
          return ok(
            JSON.stringify({
              text_id: textId,
              x: args.x,
              y: args.y,
              width: args.width,
              height,
              right_edge_x: args.x + args.width,
              bottom_edge_y: args.y + height,
            }),
          );
        },
      ),
      tool(
        'create_callout_box',
        'A prominent tinted box for KEY IDEA / WATCH OUT / CONCEPT callouts. Use for the punchline of a section ' +
          '— the one sentence the user must walk away with. Per critic rule 6 the math case is different: equations ' +
          'do NOT go in callout boxes; use create_text with fontFamily="mono" for those. Callouts are for prose takeaways.',
        {
          body: z.string().min(1).max(800),
          x: z.number(),
          y: z.number(),
          width: z.number().min(200).max(2000),
          role: z.enum(ROLES).optional(),
          tag: z.string().max(20).optional(),
        },
        async (args) => {
          const role: Role = args.role ?? 'output';
          const pal = rolePalette(role);
          const tag = args.tag ?? 'KEY IDEA';
          // Width-aware body-height (round 7, user critique 2026-04-27:
          // "text in box three is coming out of the box"). The prior
          // sizer counted only \n breaks, ignoring soft-wrap; long single
          // lines overflowed the callout's bottom edge. Now we compute
          // wrapped line count at the callout's inner width and size the
          // body accordingly.
          //
          // Body geometry (must match the body text emission below):
          //   x = args.x + CALLOUT_BODY_PAD_X (20)
          //   width = args.width - 2 * CALLOUT_BODY_PAD_X
          //   fontSize = CALLOUT_BODY_FONTSIZE (16)
          //   line-height = 1.5 × fontSize
          //   per-char width @ fontSize=16 ≈ 10 px (matches LABEL_CHAR_W
          //     calibration; sans/Excalifont mixed-case)
          const CALLOUT_BODY_PAD_X = 20;
          const CALLOUT_BODY_PAD_Y_TOP = 42; // tag row height + gap
          const CALLOUT_BODY_PAD_Y_BOTTOM = 24;
          const CALLOUT_BODY_FONTSIZE = 16;
          // Round-9 user critique: round-7's char-width=10 underestimates
          // Excalifont — actual rendered glyphs at fontSize=16 average
          // ~12 px/char (capital letters wider, italics narrower; mixed
          // sentences include both). Using 10 caused round-8's KEY-IDEA
          // body to wrap to 7 lines per the wrapper but render to 8-9
          // lines, with the trailing line spilling past the bottom edge.
          // Use 12 for safety. Per CLAUDE.md §8 — tools enforce constraints.
          const CALLOUT_BODY_CHAR_W = 12; // px/char @ fontSize 16, conservative for Excalifont
          const lineH = Math.ceil(CALLOUT_BODY_FONTSIZE * 1.5);
          const innerW = args.width - 2 * CALLOUT_BODY_PAD_X;
          // Wrap each \n-delimited paragraph independently; sum lines.
          // Reflow the body's own text with explicit \n line breaks so
          // the renderer can't over-wrap the wrapper's prediction. The
          // emitted body.text mirrors what the prediction was based on.
          const reflowedParas: string[] = [];
          let totalLines = 0;
          for (const para of args.body.split('\n')) {
            const wrapped = wrapToWidth(para.length === 0 ? ' ' : para, CALLOUT_BODY_CHAR_W, innerW);
            totalLines += Math.max(1, wrapped.length);
            reflowedParas.push(wrapped.join('\n'));
          }
          const reflowedBody = reflowedParas.join('\n');
          totalLines = Math.max(2, totalLines);
          const bodyHeight = totalLines * lineH + 16;
          const totalHeight = Math.max(
            120,
            CALLOUT_BODY_PAD_Y_TOP + bodyHeight + CALLOUT_BODY_PAD_Y_BOTTOM,
          );
          if (process.env.WBSMOKE_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.log(
              `[create_callout_box] body=${args.body.length}ch → ${totalLines}wrapped-lines × ${lineH}lineH = ${bodyHeight}body-px → callout height=${totalHeight}px (auto-grown to fit body)`,
            );
          }
          const boxId = nextId(state, 'callout');
          pushElements(state, {
            type: 'rectangle',
            id: boxId,
            x: args.x,
            y: args.y,
            width: args.width,
            height: totalHeight,
            strokeColor: pal.stroke,
            backgroundColor: pal.fill,
            strokeWidth: 2,
            strokeStyle: 'solid',
            roundness: { type: 3 },
            roughness: 0,
            fillStyle: 'solid',
            boundElements: [],
            customData: {
              fathomKind: 'wb-callout',
              role,
              tag,
            },
          } as SceneRect);
          // Tag chip (small uppercase label inside top-left)
          const tagId = nextId(state, 'callout-tag');
          pushElements(state, {
            type: 'text',
            id: tagId,
            x: args.x + 20,
            y: args.y + 14,
            width: Math.min(args.width - 40, 240),
            height: 18,
            text: tag.toUpperCase(),
            originalText: tag.toUpperCase(),
            autoResize: false,
            fontSize: 13,
            fontFamily: FONT_FAMILY_EXCALIFONT,
            textAlign: 'left',
            verticalAlign: 'top',
            strokeColor: pal.stroke,
            containerId: null,
            customData: { fathomKind: 'wb-callout-tag' },
          } as SceneText);
          // Body text (free, NOT bound to the box — bound text would
          // require auto-fit gymnastics; free text positioned inside
          // is simpler and the AC layer ignores callout-internal text.)
          const bodyId = nextId(state, 'callout-body');
          pushElements(state, {
            type: 'text',
            id: bodyId,
            x: args.x + 20,
            y: args.y + 42,
            width: args.width - 40,
            height: bodyHeight,
            text: reflowedBody,
            originalText: reflowedBody,
            autoResize: false,
            fontSize: 16,
            fontFamily: FONT_FAMILY_EXCALIFONT,
            textAlign: 'left',
            verticalAlign: 'top',
            strokeColor: '#1a1614',
            containerId: null,
            customData: { fathomKind: 'wb-callout-body' },
          } as SceneText);
          return ok(
            JSON.stringify({
              callout_id: boxId,
              x: args.x,
              y: args.y,
              width: args.width,
              height: totalHeight,
              right_edge_x: args.x + args.width,
              bottom_edge_y: args.y + totalHeight,
            }),
          );
        },
      ),
      tool(
        'set_camera',
        'Plan a camera move for the lecturer-narration tour. Cameras don\'t draw pixels; they record viewport-frame intent ' +
          'so the renderer (or critic, reading the scene JSON) can tell which part of the canvas the agent wants the user ' +
          'looking at, in what order. Per critic rule 3: plan camera moves FIRST, then build the diagram around them.',
        {
          label: z.string().max(80),
          x: z.number(),
          y: z.number(),
          width: z.number().min(40),
          height: z.number().min(40),
          step_index: z.number().int().positive().optional(),
        },
        async (args) => {
          const stepIndex =
            args.step_index ??
            state.elements.filter((e) => (e.customData as { fathomKind?: string } | undefined)?.fathomKind === 'wb-camera').length + 1;
          const camId = nextId(state, 'camera');
          // wb-camera is a pseudo-element — invisible (transparent +
          // opacity 0). The renderer's strip pass elides them so they
          // never affect the visible canvas. AC-NO-PSEUDO catches stray
          // ones.
          state.elements.push({
            type: 'rectangle',
            id: camId,
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
            strokeColor: 'transparent',
            backgroundColor: 'transparent',
            strokeWidth: 0,
            strokeStyle: 'solid',
            roundness: null,
            roughness: 0,
            fillStyle: 'solid',
            boundElements: [],
            opacity: 0,
            customData: {
              fathomKind: 'wb-camera',
              cameraLabel: args.label,
              stepIndex,
              sectionId: state.activeSectionId,
            },
          } as unknown as SceneRect);
          return ok(
            JSON.stringify({
              camera_id: camId,
              step_index: stepIndex,
              note: 'Pseudo-element. Doesn\'t render visibly; records lecturer-narration intent.',
            }),
          );
        },
      ),
      tool(
        'look_at_scene',
        'Render the CURRENT scene state to a PNG and SEE it. Returns the rendered image inline. ' +
          'Call this AFTER you have created your nodes + edges + (optionally) called describe_scene. ' +
          'Critique what you see — node overlap, text overflowing boxes, edges crossing nodes, lopsided density, ' +
          'missing visual differentiation between kinds, anything that would make the user say "this is hard to read". ' +
          'Then iterate: re-position nodes, split overcrowded boxes, switch a node to drillable=true to push detail to L2, ' +
          'or `clear_scene` and start over if the layout is fundamentally wrong. ' +
          'Cap yourself at 3 self-critique rounds — past that you are thrashing.',
        {},
        async () => {
          try {
            // Snapshot the scene state into the same .excalidraw shape
            // the production renderer loads. The render-server applies
            // its own appState scrub (mirrors WhiteboardTab.sanitiseAppStateForDisk).
            const scene = {
              type: 'excalidraw',
              version: 2,
              source: 'fathom-whiteboard',
              elements: state.elements,
              appState: { viewBackgroundColor: '#fafaf7' },
              files: {},
            };
            const png = await renderClient.render(scene);
            // SDK MCP image content block: base64 + mimeType. The
            // Agent SDK delivers this to a vision-capable Claude as
            // a visible image in the next turn. Cap at ~5MB to be
            // safe (~700KB in practice for a 5-node diagram).
            return {
              content: [
                {
                  type: 'image' as const,
                  data: png.toString('base64'),
                  mimeType: 'image/png',
                },
                {
                  type: 'text' as const,
                  text:
                    `Rendered ${state.elements.length} elements. ` +
                    `Inspect the image. Issues to look for: node overlap, text overflow, ` +
                    `crossed edges, dense clusters, missing input/output endpoints. ` +
                    `If the layout is good, call export_scene. Otherwise, fix and re-look (max 3 rounds).`,
                },
              ],
            };
          } catch (e) {
            return err(
              `look_at_scene failed: ${e instanceof Error ? e.message : String(e)}. ` +
                `Skip the visual critique and trust describe_scene + your own geometry math, ` +
                `then call export_scene.`,
            );
          }
        },
      ),
      tool(
        'request_critic_review',
        'MANDATORY before export_scene. Submits the current scene to a separate vision-critic agent ' +
          'that rasterises it and grades it against the geometric checklist + design-grammar rubric. ' +
          'Returns a structured JSON verdict: {pass: bool, defects: [...]} where each defect carries ' +
          'kind, stage_attribution, location {x,y,width,height}, fix_suggestion, severity. ' +
          'If pass=true, proceed to export_scene. If pass=false, apply each defect\'s fix_suggestion ' +
          'via more tool calls (move/resize/relabel/re-route), then call request_critic_review again. ' +
          'Capped at 3 rounds total — round 4+ returns a forced pass:true so you ship something.',
        {},
        async () => {
          // Guard: if the host didn't supply paperHash + indexPath, the
          // critic call can't ground itself. Returning err() nudges the
          // agent to skip critique and call export_scene; the renderer-
          // side runCritiqueLoop is the safety net.
          if (!opts.paperHash || !opts.indexPath) {
            return err(
              'request_critic_review unavailable: this MCP instance was not configured with paperHash + indexPath. ' +
                'Skip critique and call export_scene.',
            );
          }
          // Cap at CRITIC_REVIEW_MAX_ROUNDS. Past the cap, return a
          // forced-pass verdict so the agent breaks out of its loop
          // and proceeds to export_scene rather than starving on a
          // 4th round it isn't going to win.
          if (criticReviewRounds >= CRITIC_REVIEW_MAX_ROUNDS) {
            return ok(
              JSON.stringify({
                pass: true,
                defects: [],
                note: `max critique rounds (${CRITIC_REVIEW_MAX_ROUNDS}) reached; proceed to export_scene`,
              }),
            );
          }
          criticReviewRounds++;
          const iter = criticReviewRounds;
          try {
            // Snapshot the current scene state into the same .excalidraw
            // shape the production renderer loads.
            const scene = {
              type: 'excalidraw',
              version: 2,
              source: 'fathom-whiteboard',
              elements: state.elements,
              appState: { viewBackgroundColor: '#fafaf7' },
              files: {},
            };
            const sceneJsonString = JSON.stringify(scene);
            // Rasterise via the same render-server subprocess that
            // backs look_at_scene. Returns PNG bytes.
            const pngBytes = await renderClient.render(scene);
            // runCritique takes the PNG buffer directly — no
            // intermediate filesystem hop. The pipeline never writes
            // to disk for these snapshots; if a host wants to retain
            // them for offline inspection, they wire onArtifact at
            // their own level.
            console.log(
              `[Whiteboard request_critic_review] iter=${iter} elements=${state.elements.length} ` +
                `png=${pngBytes.length}b`,
            );
            const result = await runCritique({
              paperHash: opts.paperHash,
              indexPath: opts.indexPath,
              iter,
              pngBytes,
              sceneJsonString,
              pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
            });
            // runCritique returns null verdict on parse failure — the
            // renderer-side loop treats that as approved; mirror that
            // contract here so a single bad parse never traps the agent.
            if (!result.verdict) {
              return ok(
                JSON.stringify({
                  pass: true,
                  defects: [],
                  note: 'critique verdict unparseable; treating as pass — proceed to export_scene',
                  costUsd: result.costUsd,
                }),
              );
            }
            return ok(
              JSON.stringify({
                pass: result.verdict.pass,
                defects: result.verdict.defects,
                round: iter,
                roundsRemaining: CRITIC_REVIEW_MAX_ROUNDS - iter,
                costUsd: result.costUsd,
              }),
            );
          } catch (e) {
            return err(
              `request_critic_review failed: ${e instanceof Error ? e.message : String(e)}. ` +
                `Skip critique and call export_scene.`,
            );
          }
        },
      ),
      tool(
        'place_chat_frame',
        'CHAT MODE ONLY. Place an Excalidraw frame on the canvas to hold ' +
          'the diagram you are about to author in answer to the user\'s question. ' +
          'After this call, every create_node_with_fitted_text + connect_nodes call ' +
          'will be parented into the frame so they group visually. ' +
          'Round 14d: pass `title` (and optionally `width`/`height`) and the wrapper ' +
          'sweeps free space to the right of the L1/L2 area, then below existing chat ' +
          'frames, picking the first slot that doesn\'t overlap. Override with explicit ' +
          '`x`/`y` ONLY for deictic answers ("next to the encoder block") — call ' +
          'look_at_scene first in that case so you pick a position grounded in pixels. ' +
          'Pick a SHORT title (≤ 32 chars) that summarises the question.',
        {
          title: z.string().min(1).max(60),
          // Round 14d — x/y are now optional. When absent the wrapper
          // computes a free slot via findFreeFrameSlot below; when
          // supplied (deictic case) the agent's choice is honoured.
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().min(400).max(1800).optional(),
          height: z.number().min(200).max(1200).optional(),
        },
        async (args) => {
          if (state.meta.mode !== 'chat') {
            return err('place_chat_frame is only valid in chat mode.');
          }
          if (state.activeFrameId) {
            return err(
              `Active chat frame already exists (${state.activeFrameId}); call clear_scene to start over.`,
            );
          }
          const title = args.title.length > 32 ? args.title.slice(0, 31) + '…' : args.title;
          const frameId = nextId(state, 'frame');
          const width = args.width ?? 1100;
          const height = args.height ?? 360;
          // Round 14d — wrapper-computed free-slot sweep when the agent
          // doesn't pin (x, y) explicitly. Per ai-scientist §2.2(c):
          // try first the slot to the RIGHT of the L1/L2 area at the
          // L1 top; if that overlaps anything, drop one frame-height
          // and retry; eventually fall back to "below all existing
          // chat frames." This replaces the round-13 hardcoded
          // "x = bbox.maxX + 200" instruction (which the agent often
          // miscomputed against a stale prior scene → frames landing
          // on top of L2 or off-viewport at x≈1740).
          let placedX: number;
          let placedY: number;
          if (typeof args.x === 'number' && typeof args.y === 'number') {
            placedX = args.x;
            placedY = args.y;
          } else {
            const slot = findFreeFrameSlot(state, width, height);
            placedX = slot.x;
            placedY = slot.y;
          }
          // Validation: even in the explicit-override case, log a warning
          // if the chosen slot overlaps an existing element so the agent
          // gets feedback in the tool result. We don't reject — the agent
          // may have intentionally chosen overlap (e.g. attaching a
          // micro-chat to a specific node).
          const overlapWarning = detectFrameOverlap(state, placedX, placedY, width, height);
          // Excalidraw v0.18 frame skeleton: ExcalidrawElementSkeleton's
          // frame variant requires `type: 'frame'` + `children: string[]`
          // (per node_modules/.../data/transform.d.ts:71-74). Children
          // are computed by Excalidraw from elements whose `frameId`
          // matches this frame's id (pushElements stamps that already
          // via state.activeFrameId at line 337-338) — the children
          // array on the SKELETON can be empty and Excalidraw still
          // groups them on render. Without the children field the
          // frame skeleton is malformed and convertToExcalidrawElements
          // drops it silently — root cause of the chat-frame
          // invisibility bug observed by excalidraw-expert. We also
          // pad the base-element fields (backgroundColor, fillStyle,
          // strokeWidth, strokeStyle, roughness, opacity, angle,
          // boundElements, groupIds) so the converter doesn't reject
          // the skeleton on missing required base props.
          state.elements.push({
            type: 'frame',
            id: frameId,
            x: placedX,
            y: placedY,
            width,
            height,
            name: `Q: ${title}`,
            children: [],
            // Soft chat-orange — visually distinct from amber (#9f661b)
            // used for paper-derived L1/L2 + drillable + citation chrome.
            // Gives the user a clean provenance signal: orange = chat,
            // amber/beige = paper.
            strokeColor: '#d4793a',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 0,
            opacity: 100,
            angle: 0,
            boundElements: [],
            groupIds: [],
            customData: {
              fathomKind: 'wb-chat-frame',
              chatQueryId: state.meta.queryId,
              isChat: true,
              title,
            },
          });
          state.activeFrameId = frameId;
          return ok(
            JSON.stringify({
              frame_id: frameId,
              x: placedX,
              y: placedY,
              width,
              height,
              placement:
                typeof args.x === 'number' && typeof args.y === 'number'
                  ? 'explicit'
                  : 'wrapper-swept',
              ...(overlapWarning ? { overlap_warning: overlapWarning } : {}),
              note:
                'Active. Subsequent create/connect calls will be parented into this frame.',
            }),
          );
        },
      ),
      tool(
        'read_diagram_state',
        'CHAT MODE ONLY. Returns a JSON snapshot of what is ALREADY on the ' +
          'canvas (L1 + L2 + prior chat frames). Use it to reference existing ' +
          'nodes by name when authoring an answer that bridges to existing ' +
          'content (e.g. "this connects to the encoder block in L1"). You do ' +
          'NOT need to compute frame placement from this — place_chat_frame ' +
          'sweeps free space automatically.',
        {},
        async () => {
          if (state.meta.mode !== 'chat') {
            return err('read_diagram_state is only valid in chat mode.');
          }
          const snap = state.priorScene ?? { nodes: [], frames: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
          return ok(JSON.stringify(snap, null, 2));
        },
      ),
      // Round-13 — template library. Templates are pre-arranged
      // primitive bundles for common explanation patterns
      // (flow-chart, comparison-matrix, time-chain, key-insight-callout).
      // The agent calls list_templates() to discover what's available
      // (the catalog includes round-14+ entries flagged
      // implemented:false), then calls instantiate_template to drop
      // a configured instance into the active section. Per CLAUDE.md
      // §8 (tools enforce constraints), each template owns its own
      // geometry — element positions are computed inside the layout
      // function and the wrapper translates them to scene-absolute,
      // so no overlaps are possible inside one template instance.
      tool(
        'list_templates',
        'List the available diagram templates (curated patterns for common explanation modalities). ' +
          'Returns the full catalog from scripts/template-catalog.json — id, name, fitSignals, args schema, ' +
          'examples, priority — with each entry annotated `implemented: true|false`. Round 13 ships 4 P0 ' +
          'templates: flow-chart, comparison-matrix, time-chain, key-insight-callout. Use the catalog\'s ' +
          'fitSignals to match the section\'s content to a template (e.g. "pipeline" / "step 1 ... step 2" ' +
          '→ flow-chart; "ablation" / "vs" → comparison-matrix; "denoising step" / "iteration" → time-chain; ' +
          '"the key idea is" / "in essence" → key-insight-callout). Then call instantiate_template with the ' +
          'chosen id. Templates are ALTERNATIVES to assembling primitives by hand — pick a template when one ' +
          'fits the section\'s shape; otherwise fall back to create_node_with_fitted_text + connect_nodes.',
        {},
        async () => {
          const catalog = annotateCatalog(loadCatalog());
          return ok(JSON.stringify(catalog, null, 2));
        },
      ),
      tool(
        'instantiate_template',
        'Drop a configured template instance into the active placement container. The wrapper translates the ' +
          'template\'s layout-local elements (origin 0,0) to scene-absolute by offsetting them to the container\'s ' +
          'content area. The container is the active SECTION in pass2 mode, or the active CHAT FRAME in chat ' +
          'mode (place_chat_frame must run first). Every element gets the active sectionId / frameId stamped ' +
          'via pushElements. Returns the instantiated element ids + the bbox so the agent can stack subsequent ' +
          'content below. The wrapper rejects with a clear error if templateId is unknown, args fail validation, ' +
          'or no placement container is active.',
        {
          templateId: z.string().min(1),
          args: z.unknown(),
        },
        async (rawArgs) => {
          const { templateId, args } = rawArgs as { templateId: string; args: unknown };
          // Round 14c — placement-container abstraction. In pass2 mode
          // the container is the active section; in chat mode it's the
          // active chat frame placed via place_chat_frame. Both are
          // resolved to a {dx, dy, contentWidth, containerLabel} shape
          // before the template runs.
          const isChatMode = state.meta.mode === 'chat';
          const SECTION_PAD = 30;
          const FRAME_PAD = 24;
          let dx: number;
          let dy: number;
          let contentWidth: number;
          let containerLabel: string;
          if (isChatMode) {
            if (!state.activeFrameId) {
              return err(
                `instantiate_template: no active chat frame. Call place_chat_frame first so the template's ` +
                  `elements can be placed inside the frame's content area.`,
              );
            }
            const activeFid = state.activeFrameId;
            const frame = state.elements.find((e) => {
              if (e.type !== 'frame') return false;
              return (e as unknown as { id?: string }).id === activeFid;
            });
            if (!frame) {
              return err(
                `instantiate_template: active chat frame '${activeFid}' has no element on the canvas — frame state is corrupt; ` +
                  `call clear_scene + place_chat_frame to recover.`,
              );
            }
            const fx = (frame as { x?: number }).x ?? 0;
            const fy = (frame as { y?: number }).y ?? 0;
            const fw = (frame as { width?: number }).width ?? 1100;
            // Title sits at the top of the frame; pad below it before
            // template content begins. lastBottomY tracks bottoms across
            // all in-frame content so a 2nd instantiate stacks correctly.
            dx = fx + FRAME_PAD;
            dy = Math.max(fy + 50, state.lastBottomY + 10);
            contentWidth = fw - 2 * FRAME_PAD;
            containerLabel = `chat frame ${activeFid}`;
          } else {
            if (!state.activeSectionId) {
              return err(
                `instantiate_template: no active section. Call create_section first so the template's ` +
                  `elements can be placed inside the section's content area.`,
              );
            }
            // Resolve the active section's origin (x + content_y_start).
            // Mirrors create_node_with_fitted_text's section-bounds lookup.
            const activeSid = state.activeSectionId;
            const sectionHeader = state.elements.find((e) => {
              const cd = e.customData as { fathomKind?: string; isHeader?: boolean; sectionId?: string } | undefined;
              return cd?.fathomKind === 'wb-section' && cd?.isHeader === true && cd?.sectionId === activeSid;
            });
            if (!sectionHeader) {
              return err(
                `instantiate_template: active section '${activeSid}' has no header element — section state is corrupt; ` +
                  `call clear_scene + create_section to recover.`,
              );
            }
            const sx = (sectionHeader as { x?: number }).x ?? 60;
            const sy = (sectionHeader as { y?: number }).y ?? 0;
            const sw = (sectionHeader as { width?: number }).width ?? 1480;
            const sh = (sectionHeader as { height?: number }).height ?? 30;
            // Section subheader (if present) sits at sy+36 with height ~20;
            // start template content below either the header alone or the
            // header+subheader. A 10px gap keeps content visually separated.
            // We use lastBottomY so we stack below any prior content already
            // emitted into the section (e.g. an earlier template + a callout).
            dx = sx + SECTION_PAD;
            // Place at the larger of (section header bottom + 10) and
            // (current lastBottomY + 10). lastBottomY is updated by
            // pushElements after each element, so successive
            // instantiate_template calls stack naturally.
            dy = Math.max(sy + sh + 50, state.lastBottomY + 10);
            contentWidth = sw - 2 * SECTION_PAD;
            containerLabel = `section ${activeSid}`;
          }
          const tpl = getTemplate(templateId);
          if (!tpl) {
            return err(
              `instantiate_template: unknown templateId '${templateId}'. ` +
                `Implemented templates: ${registeredTemplateIds().join(', ')}. ` +
                `Call list_templates() to see the full catalog (including round-14+ entries that are not yet implemented).`,
            );
          }
          // Validate args via the template's own validator (throws Error
          // with a precise per-field message). Lift the throw to an MCP
          // error so the agent gets the diagnostic.
          let typedArgs: unknown;
          try {
            typedArgs = tpl.validate(args);
          } catch (e) {
            return err(
              `instantiate_template: args validation failed for templateId='${templateId}': ` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
          }
          // Run layout (template stays pure; we translate after).
          let layoutResult;
          try {
            layoutResult = tpl.layout(typedArgs, contentWidth);
          } catch (e) {
            return err(
              `instantiate_template: layout failed for templateId='${templateId}': ` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const { elements: localEls, bbox, warnings } = layoutResult;
          // Right-edge fit check — reject if the template's bbox exceeds
          // the container's content width. Per CLAUDE.md §8 the tool
          // layer is the place to catch geometric impossibility.
          if (bbox.width > contentWidth + 1) {
            return err(
              `instantiate_template: template '${templateId}' computed bbox width ${Math.round(bbox.width)}px ` +
                `exceeds active ${containerLabel} content width ${Math.round(contentWidth)}px. ` +
                `Reduce args (fewer nodes/columns/events/shorter labels) so the template fits.`,
            );
          }
          // Translate to scene-absolute, then stamp template metadata.
          // Generate a unique instance id so subsequent diagnostics + AC
          // checks can group all template-emitted elements together.
          const templateInstanceId = nextId(state, `tpl-${templateId}`);
          const sceneEls = translateElements(localEls, dx, dy);
          // Re-id every element so the templateInstanceId is part of
          // each element's id (avoids collisions with primitives + with
          // other template instances). The translateElements step is
          // shallow-copy so mutation here is safe.
          for (let i = 0; i < sceneEls.length; i += 1) {
            const oldId = sceneEls[i].id ?? `el-${i}`;
            sceneEls[i].id = `${templateInstanceId}-${oldId}`;
          }
          // Re-wire arrow start/endBindings + boundElements to the new
          // ids. Build a map old → new and rewrite. Without this the
          // arrows reference dead ids and Excalidraw's bind-tracking
          // can't keep the arrow attached when nodes move.
          const idMap = new Map<string, string>();
          for (let i = 0; i < localEls.length; i += 1) {
            const oldId = localEls[i].id;
            if (typeof oldId === 'string') idMap.set(oldId, sceneEls[i].id as string);
          }
          for (const el of sceneEls) {
            if (el.type === 'arrow') {
              const arr = el as unknown as {
                startBinding?: { elementId: string; focus: number; gap: number } | null;
                endBinding?: { elementId: string; focus: number; gap: number } | null;
              };
              if (arr.startBinding) {
                const next = idMap.get(arr.startBinding.elementId);
                if (next) arr.startBinding = { ...arr.startBinding, elementId: next };
              }
              if (arr.endBinding) {
                const next = idMap.get(arr.endBinding.elementId);
                if (next) arr.endBinding = { ...arr.endBinding, elementId: next };
              }
            }
          }
          // Stamp templateId + templateInstanceId so the renderer + AC
          // layer can identify template-emitted elements. Preserve any
          // fathomKind already set inside the template (wb-node /
          // wb-callout / wb-zone / etc.).
          stampTemplate(sceneEls, templateId, templateInstanceId);
          // Push through pushElements so:
          //   (a) sectionId gets stamped on each element
          //   (b) chat frameId gets stamped if mode='chat'
          //   (c) lastBottomY tracks the post-template bottom so the
          //       next instantiate_template / create_callout_box stacks
          //       correctly
          //   (d) the round-13 streaming snapshot fires (wb-impl-2's
          //       broadcast hook is inside pushElements so we get it free)
          pushElements(state, ...sceneEls);
          return ok(
            JSON.stringify({
              template_instance_id: templateInstanceId,
              instantiated_element_ids: sceneEls.map((el) => el.id),
              bbox: {
                x: dx,
                y: dy,
                width: bbox.width,
                height: bbox.height,
              },
              right_edge_x: dx + bbox.width,
              bottom_edge_y: dy + bbox.height,
              warnings: warnings ?? [],
              note: `Template instantiated. ${sceneEls.length} elements emitted into ${containerLabel}. ` +
                `Stack subsequent content at y ≥ ${Math.round(dy + bbox.height + 20)}.`,
            }),
          );
        },
      ),
      // Round-14b — step-loop foundation. The agent calls yield_step at
      // the end of each cohesive step (one section's worth of work).
      // The renderer's existing scene-stream broadcast already shows
      // the new elements; yield_step is purely a control-flow signal:
      // it stores the step summary on state.lastYield so the outer
      // `runPass2StepLoop` (in src/main/ai/whiteboard.ts) can flush
      // the step, optionally rasterise the canvas, and re-issue with
      // the cached prefix. Granularity: 1 section per step (per round-14
      // user lock-in). The wrapper appends to yieldHistory so the
      // outer loop can audit progress + the next step's prompt can
      // include the prior summary as context.
      tool(
        'yield_step',
        'End the current step. The renderer already sees the new elements (scene-stream is live); yield_step ' +
          'is a control-flow signal that lets the orchestrator flush, optionally rasterise, and re-issue with the ' +
          'cached Pass 1 prefix. Use this when you have completed ONE section / template / cohesive thought. ' +
          'stepSummary is shown to the user as a status line — make it user-readable, ≤120 chars. Set done=true ' +
          'when the entire whiteboard is finished; the orchestrator stops the step-loop and the next call after ' +
          'this one will be export_scene (or none, if you have already called it).',
        {
          stepSummary: z.string().min(1).max(120),
          screenshotRequest: z.boolean().optional(),
          done: z.boolean().optional(),
        },
        async (args) => {
          const yieldArgs: YieldStepArgs = {
            stepSummary: args.stepSummary,
            screenshotRequest: args.screenshotRequest ?? false,
            done: args.done ?? false,
          };
          state.lastYield = yieldArgs;
          state.yieldHistory.push(yieldArgs);
          // eslint-disable-next-line no-console
          console.log(
            `[Whiteboard yield_step] step #${state.yieldHistory.length} ` +
              `summary="${yieldArgs.stepSummary.slice(0, 80)}${yieldArgs.stepSummary.length > 80 ? '…' : ''}" ` +
              `done=${yieldArgs.done} screenshot=${yieldArgs.screenshotRequest} ` +
              `elements=${state.elements.length}`,
          );
          return ok(
            JSON.stringify({
              ok: true,
              stepNumber: state.yieldHistory.length,
              elementsAtYield: state.elements.length,
              note: yieldArgs.done
                ? 'Step-loop will terminate after this turn returns. Call export_scene if you have not already.'
                : 'Outer loop will re-issue with the cached prefix; next turn will continue from the current scene state.',
            }),
          );
        },
      ),
    ],
  });

  const getScene = () => ({
    type: 'excalidraw' as const,
    version: 2,
    source: 'fathom-whiteboard',
    elements: state.elements,
    appState: { viewBackgroundColor: '#fafaf7' } as Record<string, unknown>,
    files: {} as Record<string, unknown>,
  });

  const getActiveFrameId = () => state.activeFrameId;

  // Round-14b — step-loop accessors. `runPass2StepLoop` calls these
  // after the SDK query iterator drains so it can decide whether to
  // continue (lastYield.done === false / undefined) or terminate.
  const getLastYield = (): YieldStepArgs | undefined => state.lastYield;
  const getYieldHistory = (): readonly YieldStepArgs[] => state.yieldHistory;
  /** Reset `lastYield` to undefined between steps so the outer loop
   * can detect "the agent ran a turn but never called yield_step"
   * (treated as an implicit yield with no summary). */
  const clearLastYield = (): void => {
    state.lastYield = undefined;
  };

  // Round-14c — orchestrator-level renderScene accessor. Reuses the
  // same render-server subprocess `look_at_scene` lazily spawns. The
  // post-export critic (in runPass2StepLoop / runChatStepLoop) calls
  // this once after the agent's loop exits cleanly to grab a final
  // PNG, hand it to runCritique, and emit the advisory verdict.
  const renderScene = async (scene: {
    type: 'excalidraw';
    version: number;
    source: string;
    elements: SceneElement[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  }): Promise<Buffer> => {
    return await renderClient.render(scene);
  };

  const dispose = async (): Promise<void> => {
    // Flush + cancel any pending trailing-edge stream emit so the
    // renderer sees the final state before runPass2 resolves.
    if (streamTrailingTimer !== null) {
      clearTimeout(streamTrailingTimer);
      streamTrailingTimer = null;
      fireStream();
    }
    await renderClient.dispose();
  };

  return {
    mcp,
    getScene,
    getActiveFrameId,
    getLastYield,
    getYieldHistory,
    clearLastYield,
    renderScene,
    dispose,
  };
}
