/**
 * Host-interface seam for the Whiteboard renderer.
 *
 * The renderer doesn't know whether it's running inside Electron
 * (Fathom), inside a Vite dev server (the demo), or anywhere else.
 * It calls a `WhiteboardHost` for every operation that crosses the
 * UI / pipeline / persistence boundary. Hosts implement the interface
 * however they like:
 *
 *   - Fathom: `createElectronHost(window.lens)` — wraps the existing
 *     IPC bridge. Each method delegates to the matching `window.lens.*`
 *     call and the existing main-process IPC handler.
 *   - Demo: `createNodeSidecarHost({ baseUrl })` — wraps fetch +
 *     EventSource against a Node sidecar that runs the pipeline
 *     directly.
 *   - Tests: any mock object that satisfies `WhiteboardHost`. Wrap
 *     the tree under test in `<WhiteboardHostProvider host={mock}>`.
 *
 * Usage inside whiteboard components:
 *
 *   const host = useWhiteboardHost();
 *   const result = await host.load(paperHash);
 *
 * This module owns ONLY the React context + hook + interface
 * declaration. It does NOT ship a default Electron implementation —
 * Fathom (or any other host) constructs and passes one in. That keeps
 * this package free of Electron / Node dependencies on the renderer
 * side.
 */

import * as React from 'react';
import type { WBDiagram } from './dsl';
import type { WBCriticVerdict, PaperWhiteboard } from './store';

/**
 * Compact identifier for a paper inside the whiteboard renderer.
 * Replaces Fathom's `OpenDocument` import — only the fields the
 * whiteboard tree actually consumes.
 */
export interface WhiteboardPaperRef {
  contentHash: string;
  /** Absolute path to the index directory the host knows. Threaded
   *  through to the pipeline as the SDK `additionalDirectories`
   *  sandbox. */
  indexPath: string;
  /** Optional — used only for log lines and the share-sheet copy. */
  path?: string;
  name?: string;
}

/** Settings the renderer reads/writes through the host. The host
 *  decides where they live (Fathom: SQLite settings table; demo:
 *  in-memory or localStorage). */
export interface WhiteboardSettings {
  whiteboardSideChatCollapsed?: boolean;
  whiteboardAutoGenerateOnIndex?: boolean;
}

/** Result of `host.load(paperHash)` — fields are all optional because
 *  a brand-new paper has no saved state yet. The renderer treats
 *  every absent field as "use defaults". */
export interface LoadResult {
  indexPath?: string;
  understanding?: string;
  level1?: WBDiagram;
  level2?: Record<string, WBDiagram>;
  /** Excalidraw scene as raw JSON string. Callers JSON.parse it
   *  themselves (the renderer also runs `migrateChatFrames` on the
   *  string before parsing). */
  scene?: string;
  /** Verifier issues as raw JSON string. Callers JSON.parse to extract
   *  `{verificationRate, issues: [{quote, status, score}]}`. */
  issues?: string;
  status?: PaperWhiteboard['status'];
}

/** Generation request — verbatim shape Fathom's IPC handler today
 *  speaks. The consent gate is enforced UI-side by
 *  `WhiteboardConsent.tsx`; a generate call only happens AFTER the
 *  user has accepted the cost prompt, so the host method itself
 *  doesn't carry a consent flag. */
export interface GenerateRequest {
  paperHash: string;
  pdfPath: string;
  purposeAnchor?: string;
}

export interface GenerateHandle {
  requestId: string;
  abort: () => void;
}

export interface ExpandRequest {
  paperHash: string;
  nodeId: string;
  nodeLabel?: string;
}

export interface ExpandHandle {
  requestId: string;
  abort: () => void;
}

/** Result of `host.critique(...)` — verdict is `null` when the
 *  pipeline returned an unparseable response (the renderer treats
 *  that as approved-by-default rather than blocking). */
export interface CritiqueResult {
  verdict: WBCriticVerdict | null;
  costUsd: number;
}

export interface SaveSceneRequest {
  paperHash: string;
  scene: unknown; // Excalidraw scene JSON
}

export interface SceneStreamPayload {
  paperHash: string;
  /** Per-stream stable id — first push for a (paperHash, streamId)
   *  pair means a fresh Pass 2 generation just started. */
  streamId: string;
  elements: readonly unknown[];
}

export interface StepPayload {
  paperHash: string;
  stepNum: number;
  summary: string;
  done: boolean;
  sceneSize: number;
}

export interface VerdictPayload {
  paperHash: string;
  scope: 'l1' | 'l2' | 'chat';
  verdict: WBCriticVerdict;
  /** Set only when scope === 'chat'. The chat turn id the verdict
   *  belongs to. */
  chatQueryId?: string;
}

/** Result of `host.chatLoad(paperHash)` — frameId → ordered turns
 *  for that frame. v1 stores all chat threads for a paper as one
 *  flat per-frame map; the renderer hydrates this into the store
 *  on tab open. */
export interface ChatLoadResult {
  threads: Record<string, Array<{ role: 'user' | 'assistant'; text: string; ts: number; [k: string]: unknown }>>;
}

export interface ChatHandle {
  requestId: string;
  abort: () => void;
}

/**
 * Per-call lifecycle callbacks for `generate`. Mirrors the existing
 * Fathom IPC contract verbatim — these names are the contract that
 * the IPC main-process dispatcher already speaks. Hosts wire them
 * to whatever transport they prefer (Fathom: IPC handler dispatches;
 * demo: Server-Sent-Events filtered by the call's request id).
 */
export interface GenerateCallbacks {
  /** Pass 1 streaming text delta — fires on every text_delta from
   *  the SDK during the understanding-doc generation. */
  onPass1Delta?: (text: string) => void;
  /** Pass 1 complete — emits the final understanding text + cost. */
  onPass1Done?: (info: {
    understanding: string;
    costUsd: number;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  /** Pass 2 streaming text delta. */
  onPass2Delta?: (text: string) => void;
  /** Pass 2 complete — emits the raw scene JSON (or DSL fallback
   *  body) + cost + cache-hit signal. */
  onPass2Done?: (info: {
    raw: string;
    costUsd: number;
    cachedPrefixHit: boolean;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  /** Verifier complete — verification rate + per-quote status map. */
  onVerifier?: (info: {
    verificationRate: number;
    quoteStatus: Record<
      string,
      { status: 'verified' | 'soft' | 'unverified'; score: number }
    >;
  }) => void;
  /** Whole generation complete — sum of pass costs. Fires AFTER
   *  the renderer has stashed the L1 scene + verifier in the store. */
  onDone?: (info: { totalCost: number }) => void;
  /** Generation aborted or failed. Aborts surface here too. */
  onError?: (message: string) => void;
}

/** Per-call lifecycle callbacks for `expand` (Level 2 zoom). */
export interface ExpandCallbacks {
  onPass2Delta?: (text: string) => void;
  onPass2Done?: (info: {
    raw: string;
    parentNodeId: string;
    costUsd: number;
    cachedPrefixHit: boolean;
  }) => void;
  onDone?: (info: { totalCost: number; parentNodeId: string }) => void;
  onError?: (message: string) => void;
}

/** Per-call lifecycle callbacks for `chatSend`. */
export interface ChatSendCallbacks {
  onDelta?: (text: string) => void;
  onDone?: (info: {
    sceneModified: boolean;
    chatFrameId?: string | null;
    chatQueryId?: string | null;
    /** Scene JSON string (Excalidraw scene). Present iff
     *  sceneModified === true. */
    modifiedScene?: string;
  }) => void;
  onError?: (message: string) => void;
}

/**
 * The full renderer-host contract. Mirrors the Fathom `window.lens.*`
 * surface (per the Phase 1 enumeration); any host that satisfies this
 * interface can drop into the renderer tree without further wiring.
 *
 * Two kinds of methods:
 *  - **RPC + per-call callbacks**: `generate`, `expand`, `chatSend` —
 *    each takes a `(req, callbacks)` pair. Callbacks fire during the
 *    call's lifetime, in order. The callback names are the verbatim
 *    contract Fathom's existing IPC dispatcher speaks; renaming them
 *    is out of scope.
 *  - **Event-bus subscriptions**: `onSceneStream`, `onStep`,
 *    `onCriticVerdict` — these are app-wide notifications fired
 *    independent of any specific call (e.g. the live scene snapshot
 *    stream from Pass 2 fires for every active generate). Returns an
 *    unsubscribe fn the renderer calls in its `useEffect` cleanup.
 */
export interface WhiteboardHost {
  // --- Generation (RPC + per-call callbacks) ---
  generate(req: GenerateRequest, cb?: GenerateCallbacks): Promise<GenerateHandle>;
  expand(req: ExpandRequest, cb?: ExpandCallbacks): Promise<ExpandHandle>;
  abort(requestId: string): Promise<void>;

  // --- Persistence (host owns disk + DB) ---
  load(paperHash: string): Promise<LoadResult>;
  saveScene(paperHash: string, scene: unknown): Promise<void>;
  clear(paperHash: string): Promise<{ ok: boolean; error?: string }>;
  /** Persist a render PNG (e.g. for offline inspection). The renderer
   *  calls this once per Pass 2.5 critique iteration. The path field
   *  is what the renderer threads into `critique()` so the pipeline
   *  can `Read` the PNG. */
  writeRenderPng(
    paperHash: string,
    iter: number,
    pngBase64: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;

  // --- Pass 2.5 critique (RPC) ---
  /** Critique a rendered diagram. Returns `verdict: null` when the
   *  pipeline emitted an unparseable response — the renderer treats
   *  that as approved (so a critic-parse bug never blocks ship). */
  critique(
    paperHash: string,
    diagramJson: string,
    pngPath: string,
    iter: number,
  ): Promise<CritiqueResult>;

  // --- Chat refinement (RPC + per-call callbacks) ---
  chatLoad(paperHash: string): Promise<ChatLoadResult>;
  chatSend(
    req: {
      paperHash: string;
      frameId: string;
      userText: string;
      currentSceneJson: string;
      parentNodeId?: string;
    },
    cb?: ChatSendCallbacks,
  ): Promise<ChatHandle>;
  chatAbort(requestId: string): Promise<void>;

  // --- Event-bus subscriptions (return unsubscribe fn) ---
  onSceneStream(cb: (payload: SceneStreamPayload) => void): () => void;
  onStep(cb: (payload: StepPayload) => void): () => void;
  onCriticVerdict(cb: (payload: VerdictPayload) => void): () => void;

  // --- Asset I/O ---
  /** Read a binary asset (e.g. figure PNG) from an absolute path the
   *  host knows about. Returns a `data:` URL the renderer can drop
   *  into an `<img src>`. */
  readAssetAsDataUrl(absPath: string): Promise<string>;

  // --- Settings ---
  getSettings(): Promise<WhiteboardSettings>;
  updateSettings(patch: Partial<WhiteboardSettings>): Promise<void>;

  // --- Optional logger (no-ops if the host omits it) ---
  logDev?(level: 'info' | 'warn' | 'error', tag: string, message: string): void;
}

// --- React context wiring ----------------------------------------------

const WhiteboardHostContext = React.createContext<WhiteboardHost | null>(null);

/**
 * Wrap the whiteboard subtree to inject a host. Required — every
 * renderer component reads its host via `useWhiteboardHost()`.
 *
 * ```tsx
 * <WhiteboardHostProvider host={createElectronHost(window.lens)}>
 *   <WhiteboardTab paper={paperRef} />
 * </WhiteboardHostProvider>
 * ```
 */
export function WhiteboardHostProvider(props: {
  host: WhiteboardHost;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <WhiteboardHostContext.Provider value={props.host}>
      {props.children}
    </WhiteboardHostContext.Provider>
  );
}

/**
 * Read the host inside any whiteboard component. Throws if no
 * `WhiteboardHostProvider` wraps the call site — that's a setup bug,
 * not a runtime error path the host can recover from.
 */
export function useWhiteboardHost(): WhiteboardHost {
  const host = React.useContext(WhiteboardHostContext);
  if (!host) {
    throw new Error(
      'useWhiteboardHost called outside <WhiteboardHostProvider>. Wrap the whiteboard subtree with a host.',
    );
  }
  return host;
}
