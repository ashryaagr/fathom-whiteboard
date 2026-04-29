/**
 * Whiteboard state store. One slice per *paper hash* — keeps the
 * Pass 1 understanding doc, the Level 1 diagram, the Level 2
 * expansions keyed by parent node id, the verifier results, and the
 * current zoom/breadcrumb stack.
 *
 * Shape mirrors the lens store's per-paper map pattern: instead of one
 * global focused thing we cache by paperHash so switching papers is a
 * cheap lookup, not a re-fetch. The actual Excalidraw scene also
 * lives in the cache so a second click on the Whiteboard tab is
 * instant.
 *
 * Spec: .claude/specs/whiteboard-diagrams.md
 * Methodology doc: docs/methodology/whiteboard.md
 */

import { create } from 'zustand';
import type { WBDiagram, WBNode } from './dsl';

/** A frame id in the side-chat threads map. The L1 frame is the literal
 * string "level1"; an L2 frame is "level2:<parentNodeId>". The store
 * derives this from the focus state — the side chat reads the thread
 * for whichever frame is currently focused. */
export type WBFrameId = `level1` | `level2:${string}`;

/** One turn in the side-chat thread for a frame. user vs assistant. */
export interface WBChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Wall-clock ms for sort + persistence. */
  ts: number;
  /** Assistant turns only — true when the agent modified the scene as
   * part of this turn (the renderer flips an "applied to canvas" hint
   * + replaces the live scene). */
  sceneModified?: boolean;
  /** Assistant turns only — id of the chat-frame element this turn
   * authored. Powers the per-turn "Jump to chart" button. */
  chatFrameId?: string;
  /** Assistant turns only — 8-char per-turn id mirrored on every
   * element this turn emitted (customData.chatQueryId). */
  chatQueryId?: string;
  /** Assistant turns only — true while text is still streaming in. */
  streaming?: boolean;
  /** Assistant turns only — error message if the call failed. */
  error?: string;
}

export type WBPipelineStatus =
  | 'idle' // no whiteboard yet, no consent yet
  | 'consent' // user clicked Whiteboard tab; awaiting Generate confirmation
  | 'pass1' // Opus running
  | 'pass2' // Sonnet rendering Level 1
  | 'ready' // Level 1 hydrated, ready for drill-in
  | 'expanding' // Pass 2 (Level 2) running for some node
  | 'failed';

/** Per-paper whiteboard state. Keyed by paperHash. */
export interface PaperWhiteboard {
  status: WBPipelineStatus;
  /** Pass 1 markdown understanding doc — streamed in during pass1 and
   * kept in memory so the streaming sidebar can render incrementally. */
  understanding: string;
  /** Soft-verifier result for citation status. Populated after pass1
   * completes; renderer uses `quoteStatus` to flip the citation
   * marker between solid (verified) and dashed (unverified). */
  verificationRate: number | null;
  quoteStatus: Record<string, { status: 'verified' | 'soft' | 'unverified'; score: number }>;
  /** Level 1 diagram. */
  level1: WBDiagram | null;
  /** Level 2 diagrams keyed by their parent's WBNode.id. */
  level2: Map<string, WBDiagram>;
  /** Per-paper expansion-in-flight set so the canvas can render the
   * spinning ⌖ glyph on the right node while Pass 2 streams. */
  expandingNodeIds: Set<string>;
  /** Current navigation focus inside the whiteboard:
   *   - {kind:'level1'} → Level 1 frame
   *   - {kind:'level2', parentNodeId} → Level 2 frame for that node
   * The breadcrumb renders this stack. */
  focus: { kind: 'level1' } | { kind: 'level2'; parentNodeId: string };
  /** Drill history so the back button knows where to send the user. */
  history: Array<{ kind: 'level1' } | { kind: 'level2'; parentNodeId: string }>;
  /** Cost rollup mirrored from the main process for the optional cost
   * pill the methodology doc could expose. */
  costUsd: number;
  /** Last error surfaced to the renderer, if any. Cleared on retry. */
  error: string | null;
  /** Cached Excalidraw scene JSON the user last saw — kept in memory
   * so a tab-switch returns instantly without re-running ELK. Restored
   * from disk on first open via `whiteboardGet`. */
  excalidrawScene: string | null;
  /** Streaming sidebar contents — Pass 2 raw stream we tee into a
   * collapsible "▾ working" surface so the 5–10s Sonnet wait isn't
   * silent. Cleared when Pass 2 completes. */
  pass2Stream: string;
  /** Absolute path to the per-paper sidecar (`.../sidecars/<hash>/`).
   * Used to compose figure paths for embedding paper figures inside
   * whiteboard nodes. Populated on hydrate. */
  indexPath: string | null;
  /** MCP-driven Pass 2: raw .excalidraw scene JSON for the L1 diagram.
   * The mount effect picks this up and api.updateScene's the live
   * canvas. Null until Pass 2 completes (or when only an L2 was
   * just produced — L2s mount via pass2L2Scenes below). */
  pass2L1Scene: string | null;
  /** MCP-driven Pass 2: per-parent .excalidraw scene JSON for L2
   * expansions. The mount effect offsets each L2's elements by the
   * parent L1 rect's bottom + 200, then merges into the live canvas. */
  pass2L2Scenes: Map<string, string>;
  /** Chat-as-diagram (2026-04-26): per-chat-turn scene JSON the chat
   * agent authored as its answer. Keyed by chatQueryId (the 8-char
   * per-turn id). The chat-mount effect APPENDS each one's elements
   * to the live canvas (no removal of L1/L2/prior chats); the agent
   * has already chosen a non-overlapping (x, y) for its frame. */
  chatScenes: Map<string, string>;
  /** Side-chat threads, keyed by frame id ("level1" | "level2:<nodeId>").
   * Each thread is an ordered list of turns. Persisted to disk at
   * `<sidecar>/whiteboard-chat.json` and reloaded on hydrate. */
  chatThreads: Map<WBFrameId, WBChatTurn[]>;
  /** True iff the user has collapsed the side rail to the 32px chevron
   * strip. Persisted to settings (`whiteboardSideChatCollapsed`). */
  chatCollapsed: boolean;
  /** True while a chat call is streaming for the current frame. The Ask
   * box disables the send button and the streaming turn renders a
   * pulse. */
  chatInFlight: boolean;
  /** Round 14b — the most recent step-loop yield_step the agent has
   * called during runPass2StepLoop. Surfaces as a status string for a
   * future status-strip UI ("§1 Architecture: 5-node flow-chart from
   * photos to mesh"). Cleared when the step-loop finishes. The
   * data-path is plumbed in round 14b; the actual UI is round 14c. */
  lastStep: { stepNum: number; summary: string; done: boolean; sceneSize: number } | null;
  /** Round 14c — advisory post-export critic verdict for the L1
   * whiteboard. Stashed when the orchestrator emits the
   * `whiteboard:critic-verdict` event with `scope: 'l1'`. Non-blocking:
   * the renderer does not yet render this; an advisory-badge UI is
   * round 14d work. Null until the first verdict arrives. */
  criticVerdictL1: WBCriticVerdict | null;
  /** Round 14c — per-chat-frame advisory verdict, keyed by chatQueryId
   * (the chat agent's per-turn id stamped on every authored element).
   * Same non-blocking semantics as criticVerdictL1. */
  criticVerdictByChatQueryId: Map<string, WBCriticVerdict>;
}

/** Round 14c — minimal verdict shape carried from main → renderer.
 * Mirrors the CritiqueVerdict in src/main/ai/whiteboard-critique.ts but
 * stays renderer-pure (no Electron deps). */
export interface WBCriticVerdict {
  pass: boolean;
  defects: Array<{
    kind: string;
    stage_attribution: string;
    location: { x: number; y: number; width: number; height: number };
    fix_suggestion: string;
    severity: 'fail' | 'warn';
  }>;
}

interface WhiteboardState {
  /** paperHash → state slice. */
  byPaper: Map<string, PaperWhiteboard>;
  // ---- selectors ----
  get(paperHash: string): PaperWhiteboard;
  // ---- mutators (granular for fine-grained re-renders) ----
  setStatus(paperHash: string, status: WBPipelineStatus): void;
  /** Round 14b — record the most recent yield_step from the step-loop.
   * Pass null to clear. */
  setLastStep(
    paperHash: string,
    step: { stepNum: number; summary: string; done: boolean; sceneSize: number } | null,
  ): void;
  /** Round 14c — store the L1 post-export critic verdict (advisory).
   * Pass null to clear. */
  setCriticVerdictL1(paperHash: string, verdict: WBCriticVerdict | null): void;
  /** Round 14c — store a per-chat-frame post-export critic verdict
   * keyed by chatQueryId. */
  setCriticVerdictForChatQuery(
    paperHash: string,
    chatQueryId: string,
    verdict: WBCriticVerdict,
  ): void;
  appendUnderstanding(paperHash: string, delta: string): void;
  setUnderstanding(paperHash: string, full: string): void;
  setVerifier(
    paperHash: string,
    info: {
      verificationRate: number;
      quoteStatus: Record<string, { status: 'verified' | 'soft' | 'unverified'; score: number }>;
    },
  ): void;
  setLevel1(paperHash: string, diagram: WBDiagram): void;
  setLevel2(paperHash: string, parentNodeId: string, diagram: WBDiagram): void;
  /** MCP-driven Pass 2: store the raw .excalidraw scene JSON the agent
   * authored. The renderer's mount effect picks this up and calls
   * api.updateScene to replace the live canvas (replaces the old
   * setLevel1 → diagramToSkeleton → convertToExcalidrawElements path).
   * One field per L1 + a Map per parent node id for L2 scenes. */
  setPass2L1Scene(paperHash: string, sceneJson: string): void;
  setPass2L2Scene(paperHash: string, parentNodeId: string, sceneJson: string): void;
  /** Stash a chat-authored scene keyed by chatQueryId. The chat-mount
   * effect picks it up and APPENDS its elements to the live canvas. */
  setChatScene(paperHash: string, chatQueryId: string, sceneJson: string): void;
  startExpanding(paperHash: string, nodeId: string): void;
  endExpanding(paperHash: string, nodeId: string): void;
  appendPass2Stream(paperHash: string, delta: string): void;
  clearPass2Stream(paperHash: string): void;
  setFocus(
    paperHash: string,
    focus: { kind: 'level1' } | { kind: 'level2'; parentNodeId: string },
  ): void;
  goBack(paperHash: string): void;
  setError(paperHash: string, message: string | null): void;
  setExcalidrawScene(paperHash: string, scene: string | null): void;
  setCost(paperHash: string, costUsd: number): void;
  setIndexPath(paperHash: string, indexPath: string): void;
  // ---- side-chat mutators ----
  /** Replace the entire chat-threads map for a paper. Used on hydrate
   * from disk. */
  setChatThreads(paperHash: string, threads: Map<WBFrameId, WBChatTurn[]>): void;
  /** Append a fully-formed turn to the given frame's thread. */
  appendChatTurn(paperHash: string, frameId: WBFrameId, turn: WBChatTurn): void;
  /** Append a streaming text delta to the most recent assistant turn
   * in the given frame's thread (must already exist; created via
   * appendChatTurn with role=assistant + streaming=true beforehand). */
  appendStreamingChatDelta(paperHash: string, frameId: WBFrameId, delta: string): void;
  /** Mark the most recent assistant turn in the frame's thread as
   * complete (clears streaming flag, optionally stamps sceneModified
   * + chatFrameId + chatQueryId + error). */
  finishStreamingChatTurn(
    paperHash: string,
    frameId: WBFrameId,
    info: {
      sceneModified?: boolean;
      chatFrameId?: string;
      chatQueryId?: string;
      error?: string;
    },
  ): void;
  setChatCollapsed(paperHash: string, collapsed: boolean): void;
  setChatInFlight(paperHash: string, inFlight: boolean): void;
  /** Reset everything for one paper — useful on retry after a failed
   * generation. */
  reset(paperHash: string): void;
}

const empty = (): PaperWhiteboard => ({
  status: 'idle',
  understanding: '',
  verificationRate: null,
  quoteStatus: {},
  level1: null,
  level2: new Map(),
  expandingNodeIds: new Set(),
  focus: { kind: 'level1' },
  history: [],
  costUsd: 0,
  error: null,
  excalidrawScene: null,
  pass2Stream: '',
  indexPath: null,
  pass2L1Scene: null,
  pass2L2Scenes: new Map(),
  chatScenes: new Map(),
  chatThreads: new Map(),
  chatCollapsed: false,
  chatInFlight: false,
  lastStep: null,
  criticVerdictL1: null,
  criticVerdictByChatQueryId: new Map(),
});

/** Derive the side-chat frame id from the current focus state. */
export function frameIdFor(focus: PaperWhiteboard['focus']): WBFrameId {
  return focus.kind === 'level1' ? 'level1' : (`level2:${focus.parentNodeId}` as WBFrameId);
}

function withPatch(
  state: WhiteboardState,
  paperHash: string,
  patch: (prev: PaperWhiteboard) => Partial<PaperWhiteboard>,
): { byPaper: Map<string, PaperWhiteboard> } {
  const prev = state.byPaper.get(paperHash) ?? empty();
  const next: PaperWhiteboard = { ...prev, ...patch(prev) };
  const newMap = new Map(state.byPaper);
  newMap.set(paperHash, next);
  return { byPaper: newMap };
}

export const useWhiteboardStore = create<WhiteboardState>((set, get) => ({
  byPaper: new Map(),

  get(paperHash) {
    return get().byPaper.get(paperHash) ?? empty();
  },

  setStatus(paperHash, status) {
    set((state) => withPatch(state, paperHash, () => ({ status })));
  },

  setLastStep(paperHash, step) {
    set((state) => withPatch(state, paperHash, () => ({ lastStep: step })));
  },

  setCriticVerdictL1(paperHash, verdict) {
    set((state) => withPatch(state, paperHash, () => ({ criticVerdictL1: verdict })));
  },

  setCriticVerdictForChatQuery(paperHash, chatQueryId, verdict) {
    set((state) =>
      withPatch(state, paperHash, (prev) => {
        const next = new Map(prev.criticVerdictByChatQueryId);
        next.set(chatQueryId, verdict);
        return { criticVerdictByChatQueryId: next };
      }),
    );
  },

  appendUnderstanding(paperHash, delta) {
    set((state) =>
      withPatch(state, paperHash, (prev) => ({ understanding: prev.understanding + delta })),
    );
  },
  setUnderstanding(paperHash, full) {
    set((state) => withPatch(state, paperHash, () => ({ understanding: full })));
  },

  setVerifier(paperHash, info) {
    set((state) =>
      withPatch(state, paperHash, () => ({
        verificationRate: info.verificationRate,
        quoteStatus: info.quoteStatus,
      })),
    );
  },

  setLevel1(paperHash, diagram) {
    set((state) =>
      withPatch(state, paperHash, () => ({
        level1: applyVerifierToDiagram(diagram, state.byPaper.get(paperHash)?.quoteStatus ?? {}),
        // Default focus once L1 lands.
        focus: { kind: 'level1' },
      })),
    );
  },

  setLevel2(paperHash, parentNodeId, diagram) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const newMap = new Map(prev.level2);
      newMap.set(
        parentNodeId,
        applyVerifierToDiagram(diagram, prev.quoteStatus),
      );
      return withPatch(state, paperHash, () => ({ level2: newMap }));
    });
  },

  setPass2L1Scene(paperHash, sceneJson) {
    set((state) => withPatch(state, paperHash, () => ({ pass2L1Scene: sceneJson })));
  },

  setPass2L2Scene(paperHash, parentNodeId, sceneJson) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const next = new Map(prev.pass2L2Scenes);
      next.set(parentNodeId, sceneJson);
      return withPatch(state, paperHash, () => ({ pass2L2Scenes: next }));
    });
  },

  setChatScene(paperHash, chatQueryId, sceneJson) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const next = new Map(prev.chatScenes);
      next.set(chatQueryId, sceneJson);
      return withPatch(state, paperHash, () => ({ chatScenes: next }));
    });
  },

  startExpanding(paperHash, nodeId) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const newSet = new Set(prev.expandingNodeIds);
      newSet.add(nodeId);
      return withPatch(state, paperHash, () => ({
        expandingNodeIds: newSet,
        status: 'expanding',
        pass2Stream: '',
      }));
    });
  },

  endExpanding(paperHash, nodeId) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const newSet = new Set(prev.expandingNodeIds);
      newSet.delete(nodeId);
      return withPatch(state, paperHash, () => ({
        expandingNodeIds: newSet,
        status: newSet.size === 0 ? 'ready' : 'expanding',
      }));
    });
  },

  appendPass2Stream(paperHash, delta) {
    set((state) =>
      withPatch(state, paperHash, (prev) => ({ pass2Stream: prev.pass2Stream + delta })),
    );
  },
  clearPass2Stream(paperHash) {
    set((state) => withPatch(state, paperHash, () => ({ pass2Stream: '' })));
  },

  setFocus(paperHash, focus) {
    set((state) =>
      withPatch(state, paperHash, (prev) => {
        // Idempotent — clicking the same drillable node twice shouldn't
        // bloat the history stack with duplicates.
        const same =
          prev.focus.kind === focus.kind &&
          (prev.focus.kind === 'level1'
            ? true
            : prev.focus.parentNodeId === (focus as { parentNodeId: string }).parentNodeId);
        if (same) return {};
        return {
          focus,
          history: [...prev.history, prev.focus],
        };
      }),
    );
  },

  goBack(paperHash) {
    set((state) =>
      withPatch(state, paperHash, (prev) => {
        if (prev.history.length === 0) return { focus: { kind: 'level1' as const } };
        const next = prev.history[prev.history.length - 1];
        return {
          focus: next,
          history: prev.history.slice(0, -1),
        };
      }),
    );
  },

  setError(paperHash, message) {
    set((state) =>
      withPatch(state, paperHash, () => ({
        error: message,
        ...(message ? { status: 'failed' as const } : {}),
      })),
    );
  },

  setExcalidrawScene(paperHash, scene) {
    set((state) => withPatch(state, paperHash, () => ({ excalidrawScene: scene })));
  },

  setCost(paperHash, costUsd) {
    set((state) => withPatch(state, paperHash, () => ({ costUsd })));
  },

  setIndexPath(paperHash, indexPath) {
    set((state) => withPatch(state, paperHash, () => ({ indexPath })));
  },

  setChatThreads(paperHash, threads) {
    set((state) => withPatch(state, paperHash, () => ({ chatThreads: threads })));
  },

  appendChatTurn(paperHash, frameId, turn) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const next = new Map(prev.chatThreads);
      const existing = next.get(frameId) ?? [];
      next.set(frameId, [...existing, turn]);
      return withPatch(state, paperHash, () => ({ chatThreads: next }));
    });
  },

  appendStreamingChatDelta(paperHash, frameId, delta) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const next = new Map(prev.chatThreads);
      const existing = next.get(frameId) ?? [];
      if (existing.length === 0) return {};
      const last = existing[existing.length - 1];
      // Only stream into a streaming assistant turn — never into a user turn.
      if (last.role !== 'assistant' || !last.streaming) return {};
      const updated: WBChatTurn = { ...last, text: last.text + delta };
      next.set(frameId, [...existing.slice(0, -1), updated]);
      return withPatch(state, paperHash, () => ({ chatThreads: next }));
    });
  },

  finishStreamingChatTurn(paperHash, frameId, info) {
    set((state) => {
      const prev = state.byPaper.get(paperHash) ?? empty();
      const next = new Map(prev.chatThreads);
      const existing = next.get(frameId) ?? [];
      if (existing.length === 0) return {};
      const last = existing[existing.length - 1];
      if (last.role !== 'assistant') return {};
      const updated: WBChatTurn = {
        ...last,
        streaming: false,
        sceneModified: info.sceneModified ?? last.sceneModified ?? false,
        chatFrameId: info.chatFrameId ?? last.chatFrameId,
        chatQueryId: info.chatQueryId ?? last.chatQueryId,
        error: info.error ?? last.error,
      };
      next.set(frameId, [...existing.slice(0, -1), updated]);
      return withPatch(state, paperHash, () => ({ chatThreads: next }));
    });
  },

  setChatCollapsed(paperHash, collapsed) {
    set((state) => withPatch(state, paperHash, () => ({ chatCollapsed: collapsed })));
  },

  setChatInFlight(paperHash, inFlight) {
    set((state) => withPatch(state, paperHash, () => ({ chatInFlight: inFlight })));
  },

  reset(paperHash) {
    set((state) => {
      const newMap = new Map(state.byPaper);
      newMap.set(paperHash, empty());
      return { byPaper: newMap };
    });
  },
}));

// Test surface for headless verification (#64). Exposes the whiteboard
// zustand store on `globalThis.__whiteboard` so Playwright's
// page.evaluate() can drive state transitions directly — required to
// test the pass1/pass2 → ready flow without real Pass 1 API spend.
// Naming matches the existing renderer dev-hook convention at
// src/renderer/main.tsx:10-14 (`__lens`, `__doc`, `__regions`).
//
// Intentionally exposed in ALL builds, including the prod
// `electron-vite build` output the user installs. Reason: qa-watcher
// runs against the same prod bundle the user runs, so a DEV-gated
// hook would tree-shake out and the harness couldn't reach the
// store. Cost is ~20 bytes of bundle and one global property; this
// matches the industry pattern (React DevTools, Redux DevTools, etc.
// also expose introspection hooks in prod). The hook is read-only
// from the renderer's perspective — nothing inside the React tree
// reads it back, so accidental cross-coupling is impossible.
(globalThis as { __whiteboard?: unknown }).__whiteboard = useWhiteboardStore;

/** Apply verifier results to a diagram so its citation markers carry
 * the right verified/unverified flag at render time. We do this at
 * setLevel1/setLevel2 time so the renderer doesn't have to re-walk
 * the diagram on every render. */
function applyVerifierToDiagram(
  diagram: WBDiagram,
  quoteStatus: Record<string, { status: 'verified' | 'soft' | 'unverified'; score: number }>,
): WBDiagram {
  if (Object.keys(quoteStatus).length === 0) return diagram;
  const nodes: WBNode[] = diagram.nodes.map((n) => {
    if (!n.citation?.quote) return n;
    const lookup = quoteStatus[n.citation.quote];
    if (!lookup) return n;
    return {
      ...n,
      citation: {
        ...n.citation,
        verified: lookup.status === 'verified' || lookup.status === 'soft',
        verifyScore: lookup.score,
      },
    };
  });
  return { ...diagram, nodes };
}
