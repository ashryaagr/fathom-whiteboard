import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { WhiteboardScene, WhiteboardViewport } from './types.js';

// The agent's `create_view` tool input contains *Excalidraw element
// skeletons* — partial specs (type, x, y, width, height, text, …)
// missing the runtime-required fields (id, version, versionNonce,
// seed, groupIds, roundness, isDeleted, …). Excalidraw's updateScene
// silently rejects them; canvas stays empty.
//
// `convertToExcalidrawElements` is the official API for filling in
// the defaults. The vendor's mcp-app does the same thing
// (vendor/excalidraw-mcp/src/mcp-app.tsx:54). Using `regenerateIds:
// false` keeps any ids the agent supplied so subsequent `delete`
// elements in delta calls keep working.
//
// Idempotent on already-converted elements (no-op when the input
// already has the runtime fields), so it's safe to apply at the
// canvas boundary regardless of whether the elements came from the
// agent or from disk.
// When the agent emits a standalone text element whose center falls
// inside a container (rectangle/ellipse/diamond) that has no existing
// label, fold the text into the container's `label` skeleton field.
// convertToExcalidrawElements then produces a properly-bound,
// auto-centered text — the same result the agent would have gotten by
// using `label: {text: ...}` directly.
//
// We only auto-promote when there is EXACTLY ONE candidate text per
// container — multi-text content boxes (math notes, equation lists)
// are intentional and a single label binding can't represent them.
function autoBindOrphanText(
  elements: readonly Record<string, unknown>[] | null | undefined,
): Record<string, unknown>[] {
  type El = Record<string, unknown>;
  // Disk state from earlier versions / mid-stream IPC payloads can
  // drop the elements field entirely. Treat anything that isn't a
  // real array as "no elements"; downstream consumers handle [] fine.
  if (!Array.isArray(elements)) return [];
  const list = elements as El[];
  const isContainer = (e: El): boolean =>
    e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond';
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const containers = list.filter(
    (e) => isContainer(e) && !e.label && !(e.boundElements as unknown[] | undefined)?.length,
  );
  // Map containerId → list of candidate orphan-text indices.
  const candidates = new Map<string, number[]>();
  list.forEach((e, i) => {
    if (e.type !== 'text') return;
    if (e.containerId) return;
    const cx = num(e.x) + num(e.width) / 2;
    const cy = num(e.y) + num(e.height) / 2;
    const inside = containers.find(
      (c) =>
        cx >= num(c.x) &&
        cx <= num(c.x) + num(c.width) &&
        cy >= num(c.y) &&
        cy <= num(c.y) + num(c.height),
    );
    if (!inside) return;
    const id = String(inside.id);
    const arr = candidates.get(id) ?? [];
    arr.push(i);
    candidates.set(id, arr);
  });
  // Only promote when exactly one candidate text falls inside.
  const dropIndices = new Set<number>();
  const labelByContainerId = new Map<string, El>();
  for (const [cid, indices] of candidates) {
    if (indices.length !== 1) continue;
    const t = list[indices[0]];
    labelByContainerId.set(cid, {
      text: t.text,
      ...(t.fontSize !== undefined ? { fontSize: t.fontSize } : {}),
      ...(t.fontFamily !== undefined ? { fontFamily: t.fontFamily } : {}),
      ...(t.strokeColor !== undefined ? { strokeColor: t.strokeColor } : {}),
    });
    dropIndices.add(indices[0]);
  }
  if (dropIndices.size === 0) return list;
  return list
    .map((e, i) => {
      if (dropIndices.has(i)) return null;
      const lbl = labelByContainerId.get(String(e.id));
      if (lbl) return { ...e, label: lbl };
      return e;
    })
    .filter((e): e is El => e !== null);
}

// Excalidraw's runtime expects every element to have these array
// fields populated as actual arrays — never null, never undefined.
// Saved scenes from earlier releases (and from Excalidraw's own
// serializer) regularly write `boundElements: null` and `groupIds:
// undefined`, which is fine for round-trip but explodes when an
// Excalidraw internal does `el.boundElements.forEach(...)` without
// an array check. Normalise here so the canvas never sees a null.
function sanitizeElement(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e };
  if (!Array.isArray(out.boundElements)) out.boundElements = [];
  if (!Array.isArray(out.groupIds)) out.groupIds = [];
  // Arrows store endpoint bindings here; same array invariant.
  if (out.type === 'arrow' || out.type === 'line') {
    if (out.points !== undefined && !Array.isArray(out.points)) {
      out.points = [];
    }
  }
  return out;
}

function sanitizeElements(
  elements: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return elements.map(sanitizeElement);
}

function fillSkeletonElements(
  elements: WhiteboardScene['elements'] | null | undefined,
): WhiteboardScene['elements'] {
  // Same guard as autoBindOrphanText — elements may be missing on
  // first launch with corrupted state, on partial-stream payloads,
  // or in tests where a host stub returns a non-array.
  if (!Array.isArray(elements)) {
    console.warn(
      '[Whiteboard] fillSkeletonElements got non-array',
      typeof elements,
      elements,
    );
    return [] as WhiteboardScene['elements'];
  }
  if (elements.length === 0) return elements;
  const sanitized = sanitizeElements(
    elements as unknown as Record<string, unknown>[],
  );
  const promoted = autoBindOrphanText(sanitized);
  try {
    return convertToExcalidrawElements(
      promoted as never,
      { regenerateIds: false },
    ) as WhiteboardScene['elements'];
  } catch (err) {
    console.error(
      '[Whiteboard] convertToExcalidrawElements threw — falling back to sanitized skeletons',
      err,
    );
    // Fallback: hand the sanitized elements straight back. They lack
    // the runtime defaults that convertToExcalidrawElements would
    // have filled in, but Excalidraw will fill missing scalars
    // (versionNonce, etc.) on its own. Better an unstyled diagram
    // than a crashed renderer.
    return sanitized as unknown as WhiteboardScene['elements'];
  }
}

// Host interface — the parent app (Fathom) implements these and hands them in.
// Every method is per-call: no event subscriptions, no global stores.
export type WhiteboardHost = {
  loadScene: () => Promise<{ scene: WhiteboardScene; mtimeMs: number } | null>;
  saveScene: (scene: WhiteboardScene) => Promise<void>;
  loadViewport?: () => Promise<WhiteboardViewport | null>;
  saveViewport?: (viewport: WhiteboardViewport) => Promise<void>;
  // Optional. When implemented, paste of images/PDFs/files into the
  // chat input writes bytes to host-managed disk and returns an
  // absolute path. Hosts that haven't wired this yet should leave it
  // unset; paste of files will then be silently ignored.
  saveAsset?: (
    filename: string,
    bytes: ArrayBuffer,
  ) => Promise<{ absPath: string }>;
  // generate optionally accepts a `focus` string the user typed before
  // kicking off generation. The host should thread it down to the
  // pipeline so it appears in the system message.
  //
  // The optional `abortController`, when supplied, lets the user
  // cancel the in-flight run mid-stream (e.g. by typing a new prompt
  // and pressing Send). Hosts that don't support cancellation can
  // ignore it; the run will simply finish on its own.
  generate: (
    cb: {
      onLog?: (s: string) => void;
      onScene?: (scene: WhiteboardScene) => void;
    },
    focus?: string,
    abortController?: AbortController,
  ) => Promise<{ scene: WhiteboardScene; usd: number }>;
  refine: (
    scene: WhiteboardScene,
    instruction: string,
    cb: {
      onLog?: (s: string) => void;
      onScene?: (scene: WhiteboardScene) => void;
    },
    abortController?: AbortController,
  ) => Promise<{ scene: WhiteboardScene; usd: number }>;
  clear?: () => Promise<void>;
};

type Attachment = {
  name: string;
  absPath: string;
  kind: 'image' | 'file';
};

// Build the markdown prefix for a list of attachments. Image kind
// uses `![…](…)` so the agent's Read tool reads it as visual; file
// kind uses `[…](…)`. A single newline between attachments, blank
// line before the user's text.
function buildAttachmentPrefix(atts: Attachment[]): string {
  if (atts.length === 0) return '';
  const lines = atts.map((a) =>
    a.kind === 'image'
      ? `![attached image: ${a.name}](${a.absPath})`
      : `[attached file: ${a.name}](${a.absPath})`,
  );
  return `${lines.join('\n')}\n\n`;
}

type Props = {
  host: WhiteboardHost;
};

type ExcalidrawApi = {
  updateScene: (s: {
    elements?: readonly unknown[];
    appState?: Record<string, unknown>;
  }) => void;
  scrollToContent: (
    target?: readonly unknown[],
    opts?: { fitToContent?: boolean; animate?: boolean; duration?: number },
  ) => void;
  getAppState: () => Record<string, unknown>;
  getSceneElements: () => readonly unknown[];
};

type ExcalidrawAppState = {
  scrollX?: number;
  scrollY?: number;
  zoom?: { value?: number } | number;
};

function readViewport(appState: ExcalidrawAppState): WhiteboardViewport {
  const zoomVal =
    typeof appState.zoom === 'number'
      ? appState.zoom
      : appState.zoom?.value ?? 1;
  return {
    scrollX: appState.scrollX ?? 0,
    scrollY: appState.scrollY ?? 0,
    zoom: zoomVal,
  };
}

function viewportEqual(a: WhiteboardViewport | null, b: WhiteboardViewport): boolean {
  if (!a) return false;
  return (
    Math.abs(a.scrollX - b.scrollX) < 1 &&
    Math.abs(a.scrollY - b.scrollY) < 1 &&
    Math.abs(a.zoom - b.zoom) < 0.001
  );
}

const SIDE_PANEL_WIDTH = 360;
const SIDE_PANEL_COLLAPSED_WIDTH = 28;

// Status indicator: a 7px dot whose colour + animation reflect what
// the agent is doing. Quiet when idle, gently pulsing when an agent
// run is in flight, red on error. Reads as Apple-system semantic.
function StatusDot({ status }: { status: string }) {
  const color =
    status === 'error'
      ? '#ff453a'
      : status === 'generating' || status === 'refining'
      ? '#0a84ff'
      : status === 'awaiting-focus'
      ? '#ff9f0a'
      : status === 'idle'
      ? '#30d158'
      : '#86868b';
  const animate = status === 'generating' || status === 'refining';
  return (
    <>
      <span
        style={{
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: animate ? `0 0 0 0 ${color}66` : 'none',
          animation: animate ? 'wbPulse 1.6s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      <style>{`
        @keyframes wbPulse {
          0%   { box-shadow: 0 0 0 0 ${color}66; }
          50%  { box-shadow: 0 0 0 6px ${color}00; }
          100% { box-shadow: 0 0 0 0 ${color}00; }
        }
      `}</style>
    </>
  );
}
// 400ms debounce on every save path. Tight enough that a tab close /
// crash loses ≤1 frame of pan, zoom, or edit; loose enough that a
// burst of agent emits or rapid panning coalesces into a single write.
const SAVE_DEBOUNCE_MS = 400;

// Sentinel pushed into logLines when a run completes. The renderer
// groups everything between two sentinels (or [you] markers) into
// one collapsible turn. We use a glyph the model would never produce.
const TURN_END_SENTINEL = ' __turn_end__';

type LogTurn = {
  // The user's message that kicked this turn off, if any. The first
  // turn after app launch may have no user message (e.g. a hydrated
  // scene from disk with prior history that's been forgotten).
  userMessage?: string;
  // Lines emitted by the agent while this turn was streaming —
  // [system], [tool_use], [tool_result], [thinking], [assistant],
  // [result]. Excludes the leading [you] and the trailing TURN_END.
  agentLines: string[];
  // Errors hoisted out of agentLines so they stay visible even when
  // the rest of the turn collapses.
  errors: string[];
  // True once we've seen a TURN_END for this turn. Closed turns render
  // collapsed by default with a hairline separator below.
  closed: boolean;
};

function groupIntoTurns(lines: string[]): LogTurn[] {
  const out: LogTurn[] = [];
  let cur: LogTurn = { agentLines: [], errors: [], closed: false };
  let curHasContent = false;
  const push = () => {
    if (cur.userMessage !== undefined || curHasContent) {
      out.push(cur);
    }
    cur = { agentLines: [], errors: [], closed: false };
    curHasContent = false;
  };
  for (const line of lines) {
    if (line === TURN_END_SENTINEL) {
      cur.closed = true;
      push();
      continue;
    }
    if (line.startsWith('[you] ')) {
      // A new [you] also closes any prior open turn, even if no
      // TURN_END landed yet (rare — would only happen if the user
      // sent before the prior run reported done).
      if (cur.userMessage !== undefined || curHasContent) push();
      cur.userMessage = line.slice('[you] '.length);
      curHasContent = true;
      continue;
    }
    if (line.startsWith('[error] ')) {
      cur.errors.push(line);
      curHasContent = true;
      continue;
    }
    cur.agentLines.push(line);
    curHasContent = true;
  }
  if (cur.userMessage !== undefined || curHasContent) {
    out.push(cur);
  }
  return out;
}

// Long log lines (tool inputs + results) get collapsed under a one-line
// preview. <details> is keyboard-accessible and copy-friendly for free.
const LOG_PREVIEW_CHARS = 120;

function LogLine({ line, isLatest }: { line: string; isLatest: boolean }) {
  const isMono =
    line.startsWith('[tool_use]') ||
    line.startsWith('[tool_result]') ||
    line.startsWith('[result]') ||
    line.startsWith('[system]');
  const isYou = line.startsWith('[you] ');
  const isError = line.startsWith('[error] ');

  // User messages render as a right-aligned chat bubble — feels like
  // Claude / iMessage rather than a tagged log line. The `[you] ` tag is
  // a routing marker for this branch only; we strip it before rendering.
  if (isYou) {
    const body = line.slice('[you] '.length);
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 8,
          marginTop: 2,
        }}
      >
        <div
          style={{
            maxWidth: '85%',
            padding: '8px 12px',
            background: '#1d1d1f',
            color: '#fff',
            borderRadius: '14px 14px 4px 14px',
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {body}
        </div>
      </div>
    );
  }

  // Errors render as a left-aligned, alarm-coloured bubble. Always
  // expanded, never truncated — the user has to be able to read these.
  if (isError) {
    const body = line.slice('[error] '.length);
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          marginBottom: 8,
          marginTop: 2,
        }}
      >
        <div
          style={{
            maxWidth: '95%',
            padding: '8px 12px',
            background: 'rgba(220,0,0,0.06)',
            color: '#c00',
            border: '1px solid rgba(220,0,0,0.22)',
            borderRadius: '14px 14px 14px 4px',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontWeight: 500,
          }}
        >
          {body}
        </div>
      </div>
    );
  }

  const baseStyle: React.CSSProperties = {
    marginBottom: 3,
    color: isLatest ? '#1d1d1f' : '#3a3a3c',
    fontFamily: isMono
      ? "ui-monospace, 'SF Mono', Menlo, monospace"
      : 'inherit',
    fontSize: isMono ? 11 : 12,
  };
  if (line.length <= LOG_PREVIEW_CHARS) {
    return <div style={baseStyle}>{line}</div>;
  }
  const preview = `${line.slice(0, LOG_PREVIEW_CHARS)}…`;
  return (
    <details style={{ ...baseStyle, whiteSpace: 'pre-wrap' }}>
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          color: isLatest ? '#1d1d1f' : '#3a3a3c',
          // Hide the default disclosure triangle in Safari/WebKit by
          // suppressing the marker; we use the ▸ glyph below instead.
          // Subtle and consistent with Apple's expand affordances.
        }}
      >
        <span style={{ color: '#86868b', marginRight: 4 }}>▸</span>
        {preview}
      </summary>
      <div
        style={{
          paddingLeft: 14,
          marginTop: 4,
          color: '#3a3a3c',
          fontSize: isMono ? 11 : 12,
          fontFamily: isMono
            ? "ui-monospace, 'SF Mono', Menlo, monospace"
            : 'inherit',
        }}
      >
        {line}
      </div>
    </details>
  );
}

// One turn = one user-send + the agent's full response. Closed turns
// collapse the agent's verbose work (system / tool_use / tool_result /
// thinking / assistant) under a `Show details` summary, but always
// keep the user message bubble + any errors visible. A hairline below
// each closed turn marks the boundary so adjacent runs read as
// separate exchanges.
function TurnGroup({ turn, isLastTurn }: { turn: LogTurn; isLastTurn: boolean }) {
  const collapsible = turn.agentLines.length > 0;
  const renderUser = () =>
    turn.userMessage !== undefined ? (
      <LogLine line={`[you] ${turn.userMessage}`} isLatest={false} />
    ) : null;
  const renderErrors = () =>
    turn.errors.map((e, i) => (
      <LogLine key={`e${i}`} line={e} isLatest={false} />
    ));
  const separatorStyle: React.CSSProperties = {
    height: 1,
    background:
      'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0) 100%)',
    margin: '14px 0 10px',
  };

  if (turn.closed) {
    return (
      <div>
        {renderUser()}
        {collapsible && (
          <details
            style={{
              fontSize: 12,
              color: '#86868b',
              marginBottom: turn.errors.length > 0 ? 6 : 0,
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                listStyle: 'none',
                color: '#86868b',
                userSelect: 'none',
                padding: '4px 0',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ color: '#c7c7cc' }}>▸</span>
              <span>Activity · {turn.agentLines.length} {turn.agentLines.length === 1 ? 'line' : 'lines'}</span>
            </summary>
            <div style={{ paddingTop: 6, paddingLeft: 14 }}>
              {turn.agentLines.map((line, i) => (
                <LogLine key={i} line={line} isLatest={false} />
              ))}
            </div>
          </details>
        )}
        {renderErrors()}
        {!isLastTurn && <div style={separatorStyle} aria-hidden="true" />}
      </div>
    );
  }

  // Open turn: streaming live, render flat so the user sees activity
  // as it happens. The collapse happens automatically when the run
  // ends and `closed` flips.
  return (
    <div>
      {renderUser()}
      {turn.agentLines.map((line, i) => (
        <LogLine
          key={i}
          line={line}
          isLatest={i === turn.agentLines.length - 1 && turn.errors.length === 0}
        />
      ))}
      {renderErrors()}
    </div>
  );
}

export function Whiteboard({ host }: Props) {
  // 'awaiting-focus' = no scene on disk and we're letting the user
  //                    type a focus prompt before kicking off generation.
  // 'generating'      = pipeline is running.
  // 'refining'        = chat-driven refine() is running.
  // 'idle'            = scene on canvas, nothing in flight.
  // 'loading'         = initial host.loadScene() in flight.
  // 'error'           = surfaced with the message in errorMsg.
  const [status, setStatus] = useState<
    'loading' | 'awaiting-focus' | 'idle' | 'generating' | 'refining' | 'error'
  >('loading');
  const [hasGenerated, setHasGenerated] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  // Controller for the in-flight generate/refine run. When the user
  // sends a new prompt while a run is streaming we abort this and
  // start a fresh one (ChatGPT/Claude UX).
  const runControllerRef = useRef<AbortController | null>(null);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const sceneRef = useRef<WhiteboardScene>({ elements: [] });
  const logFeedRef = useRef<HTMLDivElement | null>(null);

  // Viewport plumbing.
  const pendingInitialViewportRef = useRef<WhiteboardViewport | null>(null);
  const didAutoFitRef = useRef(false);
  const lastSavedViewportRef = useRef<WhiteboardViewport | null>(null);
  const saveViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scene auto-save plumbing. Every Excalidraw onChange (whether
  // triggered by a streaming agent emit OR by a user dragging a
  // shape) schedules a debounced save. `canSaveRef` gates against
  // saving the empty initial scene before we've loaded/generated
  // anything.
  const saveSceneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canSaveRef = useRef(false);

  const log = (line: string) => {
    setLogLines((prev) => {
      const trimmed = prev.slice(-199);
      // Coalesce consecutive [thinking] heartbeats: each new heartbeat
      // replaces the previous one in place rather than appending. Keeps
      // the activity panel readable during long create_view streams.
      if (
        line.startsWith('[thinking]') &&
        trimmed.length > 0 &&
        trimmed[trimmed.length - 1].startsWith('[thinking]')
      ) {
        return [...trimmed.slice(0, -1), line];
      }
      return [...trimmed, line];
    });
  };

  // Mark the boundary between conversational turns. Emit a sentinel
  // into the log stream the moment a run finishes (success or error)
  // so the renderer can group everything between this boundary and the
  // previous one as one collapsible turn, with a hairline below it.
  const lastStatusRef = useRef(status);
  useEffect(() => {
    const prev = lastStatusRef.current;
    const wasRunning = prev === 'generating' || prev === 'refining';
    const isRestful =
      status === 'idle' || status === 'error' || status === 'awaiting-focus';
    if (wasRunning && isRestful) {
      setLogLines((p) => [...p, TURN_END_SENTINEL]);
    }
    lastStatusRef.current = status;
  }, [status]);

  useEffect(() => {
    const el = logFeedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // Intercept Cmd/Ctrl+S in capture phase so Excalidraw's built-in
  // 'Save to file' dialog never opens. Auto-save is already firing
  // on every onChange; the keystroke just force-flushes any pending
  // debounced write and surfaces a brief 'Saved' toast so the user
  // gets the 'I hit save' acknowledgement they expected.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
      if (!isSave) return;
      e.preventDefault();
      e.stopPropagation();
      if (saveSceneTimerRef.current) {
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
      }
      flushSaveScene(sceneRef.current);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1200);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [host]);

  const flushSaveScene = (scene: WhiteboardScene) => {
    if (!canSaveRef.current) {
      console.log('[Whiteboard] flushSaveScene SKIPPED (canSaveRef=false)');
      return;
    }
    if (scene.elements.length === 0) {
      console.log('[Whiteboard] flushSaveScene SKIPPED (empty)');
      return;
    }
    console.log(`[Whiteboard] flushSaveScene → ${scene.elements.length} elements via host.saveScene`);
    void host.saveScene(scene).catch(() => {
      /* next change will retry */
    });
  };

  const scheduleSaveScene = (scene: WhiteboardScene) => {
    if (saveSceneTimerRef.current) clearTimeout(saveSceneTimerRef.current);
    saveSceneTimerRef.current = setTimeout(
      () => flushSaveScene(scene),
      SAVE_DEBOUNCE_MS,
    );
  };

  const applyViewportToCanvas = (vp: WhiteboardViewport) => {
    if (!apiRef.current) {
      pendingInitialViewportRef.current = vp;
      return;
    }
    apiRef.current.updateScene({
      appState: {
        scrollX: vp.scrollX,
        scrollY: vp.scrollY,
        zoom: { value: vp.zoom },
      },
    });
    lastSavedViewportRef.current = vp;
  };

  const autoFitToContent = () => {
    if (didAutoFitRef.current) return;
    if (!apiRef.current) return;
    const elements = apiRef.current.getSceneElements();
    if (elements.length === 0) return;
    didAutoFitRef.current = true;
    apiRef.current.scrollToContent(elements, {
      fitToContent: true,
      animate: true,
      duration: 350,
    });
  };

  // applySceneToCanvas — invoked by the streaming pipeline as the
  // agent emits scenes. It updates the canvas; the resulting onChange
  // will flow through handleExcalidrawChange and trigger a debounced
  // scene save automatically.
  //
  // The agent's elements are skeleton specs; fill in defaults via
  // `fillSkeletonElements` before handing to Excalidraw (otherwise
  // updateScene silently no-ops). Store the FILLED form in sceneRef
  // so the disk save round-trips a fully-formed scene that re-opens
  // correctly without needing another conversion.
  const applySceneToCanvas = (next: WhiteboardScene) => {
    const filled: WhiteboardScene = {
      elements: fillSkeletonElements(next.elements),
    };
    sceneRef.current = filled;
    setHasGenerated(true);
    canSaveRef.current = true;
    if (apiRef.current) {
      apiRef.current.updateScene({ elements: filled.elements });
    }
  };

  // Abort any in-flight run. Called when the user submits a new
  // prompt while the previous one is still streaming.
  const abortInflightRun = () => {
    const ctrl = runControllerRef.current;
    if (ctrl && !ctrl.signal.aborted) {
      ctrl.abort();
    }
    runControllerRef.current = null;
  };

  const startGeneration = async (focusText: string) => {
    abortInflightRun();
    const controller = new AbortController();
    runControllerRef.current = controller;
    setStatus('generating');
    try {
      const { scene: fresh } = await host.generate(
        {
          onLog: log,
          onScene: applySceneToCanvas,
        },
        focusText.trim() || undefined,
        controller,
      );
      // If we were superseded by a newer run, drop our result on the
      // floor — the newer run owns the canvas now.
      if (runControllerRef.current !== controller) return;
      applySceneToCanvas(fresh);
      // Flush any pending debounced save and force an immediate write
      // of the final scene — closing the tab should never lose the
      // last frame.
      if (saveSceneTimerRef.current) {
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
      }
      await host.saveScene(fresh);
      queueMicrotask(autoFitToContent);
      setStatus('idle');
      runControllerRef.current = null;
    } catch (err) {
      if (runControllerRef.current !== controller) return;
      const msg = (err as Error).message || String(err);
      setErrorMsg(msg);
      log(`[error] ${msg}`);
      setStatus('error');
      runControllerRef.current = null;
    }
  };

  // Initial load — try host.loadScene(); if absent, surface the focus
  // prompt UI rather than auto-generating. The user gets to specify
  // what the diagram should foreground before we burn the API spend.
  useEffect(() => {
    console.log('[Whiteboard] mount — loadScene effect starting');
    let cancelled = false;
    (async () => {
      try {
        const viewportPromise = host.loadViewport
          ? host.loadViewport().catch(() => null)
          : Promise.resolve(null);
        const persisted = await host.loadScene();
        // Some hosts / older disk states return scene without an
        // elements array. Normalise so the rest of this effect (and
        // the user-visible log line) sees a real array.
        const persistedElements = Array.isArray(persisted?.scene?.elements)
          ? persisted.scene.elements
          : [];
        console.log(
          `[Whiteboard] loadScene returned: ${
            persisted ? `${persistedElements.length} elements` : 'null'
          }`,
        );
        if (cancelled) return;
        const persistedViewport = await viewportPromise;
        if (cancelled) return;

        if (persisted && persistedElements.length > 0) {
          // Defensive convert: scenes saved before the
          // fillSkeletonElements fix may still be in skeleton form on
          // disk. Idempotent on already-converted scenes.
          let filled: WhiteboardScene;
          try {
            filled = {
              elements: fillSkeletonElements(persistedElements),
            };
          } catch (err) {
            console.error(
              '[Whiteboard] fillSkeletonElements crashed during loadScene; starting blank',
              err,
            );
            filled = { elements: [] };
          }
          sceneRef.current = filled;
          setHasGenerated(true);
          canSaveRef.current = true;
          if (apiRef.current) {
            try {
              apiRef.current.updateScene({ elements: filled.elements });
            } catch (err) {
              console.error(
                '[Whiteboard] apiRef.updateScene crashed during loadScene; canvas left empty',
                err,
              );
            }
          }
          if (persistedViewport) {
            applyViewportToCanvas(persistedViewport);
            didAutoFitRef.current = true;
          } else {
            queueMicrotask(autoFitToContent);
          }
          setStatus('idle');
          return;
        }
        // No persisted scene → wait for the user to type a focus
        // prompt and click Generate.
        setStatus('awaiting-focus');
      } catch (err) {
        if (cancelled) return;
        const msg = (err as Error).message || String(err);
        setErrorMsg(msg);
        log(`[error] ${msg}`);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (saveViewportTimerRef.current) {
        clearTimeout(saveViewportTimerRef.current);
        saveViewportTimerRef.current = null;
      }
      if (saveSceneTimerRef.current) {
        // A save is pending. Cancel it without flushing — the host's
        // saveScene already has a clearing-guard, but flushing here
        // also races with explicit clear() writes when the unmount is
        // triggered by a key={resetCount} bump (New button). Anything
        // older than SAVE_DEBOUNCE_MS is already on disk; the small
        // tail-end window is acceptable to lose vs. the much worse
        // failure mode of writing stale state over a fresh clear.
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
      }
    };
  }, [host]);

  // Build a single human-readable summary of what the user just sent —
  // text + the names of any attached files — so the chat shows the
  // user's contribution before the agent's response.
  const summarizeSend = (text: string, atts: Attachment[]): string => {
    const parts: string[] = [];
    if (atts.length > 0) {
      parts.push(...atts.map((a) => `📎 ${a.name}`));
    }
    if (text.length > 0) parts.push(text);
    return parts.join('\n');
  };

  const handleSendOrGenerate = async () => {
    const text = chatInput.trim();
    const prefix = buildAttachmentPrefix(attachments);
    const composed = (prefix + text).trim();
    const echo = summarizeSend(text, attachments);

    if (status === 'awaiting-focus') {
      // Even with empty text + no attachments we still let through —
      // generate runs on placeholder content. Echo whatever the user
      // gave us so they can see it persist in the chat.
      if (echo.length > 0) log(`[you] ${echo}`);
      setChatInput('');
      setAttachments([]);
      await startGeneration(composed);
      return;
    }
    // Allow Send during a run (busy) by aborting the in-flight one
    // and starting a fresh refine. `hasGenerated` gate still applies —
    // a Send with no scene yet falls through to startGeneration above.
    if (!hasGenerated) return;
    if (!composed) return;

    abortInflightRun();
    const controller = new AbortController();
    runControllerRef.current = controller;
    if (echo.length > 0) log(`[you] ${echo}`);
    setChatInput('');
    setAttachments([]);
    setStatus('refining');
    try {
      const { scene: next } = await host.refine(
        sceneRef.current,
        composed,
        {
          onLog: log,
          onScene: applySceneToCanvas,
        },
        controller,
      );
      if (runControllerRef.current !== controller) return;
      applySceneToCanvas(next);
      if (saveSceneTimerRef.current) {
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
      }
      await host.saveScene(next);
      setStatus('idle');
      runControllerRef.current = null;
    } catch (err) {
      if (runControllerRef.current !== controller) return;
      const msg = (err as Error).message || String(err);
      setErrorMsg(msg);
      log(`[error] ${msg}`);
      setStatus('error');
      runControllerRef.current = null;
    }
  };

  // Paste handler — scan clipboard for files (images, PDFs, anything)
  // and persist each via host.saveAsset. On success, surface a chip
  // above the textarea. Text paste falls through to default behaviour.
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files: File[] = [];
    if (dt.files && dt.files.length > 0) {
      for (let i = 0; i < dt.files.length; i++) files.push(dt.files[i]);
    } else if (dt.items && dt.items.length > 0) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (files.length === 0) return;
    if (!host.saveAsset) return; // host hasn't wired persistence yet
    e.preventDefault();
    const saved: Attachment[] = [];
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer();
        const filename = f.name && f.name.length > 0 ? f.name : `attachment-${Date.now()}`;
        const { absPath } = await host.saveAsset(filename, bytes);
        const isImage =
          f.type.startsWith('image/') ||
          /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
        saved.push({ name: filename, absPath, kind: isImage ? 'image' : 'file' });
      } catch {
        // Best-effort — drop a single bad file rather than blocking
        // the whole paste. Other attachments still go through.
      }
    }
    if (saved.length > 0) {
      setAttachments((prev) => [...prev, ...saved]);
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // onChange fires for EVERY Excalidraw interaction — streaming
  // updateScene, manual drag, undo/redo, pan, zoom. We auto-save the
  // scene from here so user edits land on disk just like agent emits
  // do. Viewport persistence shares the handler; both are debounced
  // independently.
  const handleExcalidrawChange = (
    elements: readonly unknown[],
    appState: ExcalidrawAppState,
  ) => {
    // Mirror canonical state into sceneRef so chat refinement always
    // sends what the user is actually looking at.
    if (canSaveRef.current && elements.length > 0) {
      const next = { elements: [...elements] as WhiteboardScene['elements'] };
      sceneRef.current = next;
      scheduleSaveScene(next);
    }

    if (host.saveViewport) {
      const vp = readViewport(appState);
      if (!viewportEqual(lastSavedViewportRef.current, vp)) {
        if (saveViewportTimerRef.current) clearTimeout(saveViewportTimerRef.current);
        saveViewportTimerRef.current = setTimeout(() => {
          if (viewportEqual(lastSavedViewportRef.current, vp)) return;
          lastSavedViewportRef.current = vp;
          void host.saveViewport!(vp).catch(() => {});
        }, 250);
      }
    }
  };

  const busy = status === 'generating' || status === 'refining';
  const sidePanelWidth = panelCollapsed ? SIDE_PANEL_COLLAPSED_WIDTH : SIDE_PANEL_WIDTH;

  // Input + button affordances. Typing is ALWAYS enabled — even mid
  // run — so the user can compose a follow-up while the agent is
  // streaming. Submitting while busy aborts the in-flight run and
  // starts a fresh one.
  let inputPlaceholder = 'Refine the whiteboard…';
  let buttonLabel = 'Send';
  if (status === 'awaiting-focus') {
    inputPlaceholder = 'Paste anything — text, a PDF, an image — or describe what to draw. Enter to send.';
    buttonLabel = 'Generate';
  } else if (busy) {
    inputPlaceholder = 'Type a follow-up — Send aborts current run';
  } else if (status === 'loading') {
    inputPlaceholder = 'Loading…';
  } else if (status === 'error') {
    inputPlaceholder = 'Refine the whiteboard…';
  }
  const hasContent = chatInput.trim().length > 0 || attachments.length > 0;
  // Send is disabled only when there is nothing to send. Loading/error
  // states still gate via hasGenerated/hasContent.
  const sendDisabled =
    status === 'loading' ||
    (status === 'awaiting-focus' ? false : !hasGenerated || !hasContent);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%' }}>
      <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
        <Excalidraw
          initialData={{
            elements: [] as never,
            appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 } as never,
          }}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as ExcalidrawApi;
            const els = Array.isArray(sceneRef.current.elements)
              ? sceneRef.current.elements
              : [];
            if (els.length > 0) {
              try {
                apiRef.current.updateScene({ elements: els });
              } catch (err) {
                console.error(
                  '[Whiteboard] excalidrawAPI replay updateScene failed',
                  err,
                  els.length,
                );
              }
            }
            if (pendingInitialViewportRef.current) {
              applyViewportToCanvas(pendingInitialViewportRef.current);
              pendingInitialViewportRef.current = null;
            }
          }}
          onChange={handleExcalidrawChange as unknown as never}
        />
        {busy && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.9)',
              border: '1px solid #ddd',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'system-ui',
              pointerEvents: 'none',
            }}
          >
            {status === 'generating' ? 'Generating…' : 'Refining…'}
          </div>
        )}
        {savedToast && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '6px 12px',
              background: 'rgba(30,30,30,0.85)',
              color: '#fff',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'system-ui',
              pointerEvents: 'none',
              transition: 'opacity 200ms',
            }}
          >
            Saved
          </div>
        )}
        {status === 'awaiting-focus' && (
          // Subtle hint over the empty canvas — points the user at
          // the side panel for the focus prompt rather than expecting
          // them to find it.
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              fontFamily: 'system-ui',
              color: '#999',
              fontSize: 14,
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>
                Paste anything. Get a whiteboard.
              </div>
              <div>Drop a PDF, paste an image, or describe what to draw — on the right.</div>
            </div>
          </div>
        )}
        {status === 'error' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.92)',
              color: '#c00',
              fontFamily: 'system-ui',
              padding: 16,
            }}
          >
            <div style={{ maxWidth: 480, textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Whiteboard failed</div>
              <div style={{ fontSize: 13 }}>{errorMsg}</div>
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          width: sidePanelWidth,
          borderLeft: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(248,248,250,0.85)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          transition: 'width 220ms cubic-bezier(0.32,0.72,0,1)',
          flexShrink: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif",
          fontFeatureSettings: "'kern','liga','calt'",
        }}
      >
        {panelCollapsed ? (
          <button
            onClick={() => setPanelCollapsed(false)}
            title="Show activity"
            aria-label="Show activity panel"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              color: '#86868b',
              fontFamily: 'inherit',
              writingMode: 'vertical-rl',
              padding: '14px 0',
              letterSpacing: '0.01em',
            }}
          >
            Activity
          </button>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px 10px',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                fontSize: 13,
                color: '#1d1d1f',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot status={status} />
                <span style={{ fontWeight: 600, letterSpacing: '-0.005em' }}>
                  {status === 'generating'
                    ? 'Generating'
                    : status === 'refining'
                    ? 'Refining'
                    : status === 'loading'
                    ? 'Loading'
                    : status === 'awaiting-focus'
                    ? 'Ready to generate'
                    : status === 'error'
                    ? 'Error'
                    : 'Whiteboard'}
                </span>
              </div>
              <button
                onClick={() => setPanelCollapsed(true)}
                title="Collapse"
                aria-label="Collapse activity panel"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  color: '#86868b',
                  padding: 4,
                  borderRadius: 6,
                  transition: 'background 120ms ease, color 120ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(0,0,0,0.06)';
                  e.currentTarget.style.color = '#1d1d1f';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = '#86868b';
                }}
              >
                ›
              </button>
            </div>

            <div
              ref={logFeedRef}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '10px 14px',
                fontSize: 12,
                lineHeight: 1.55,
                color: '#3a3a3c',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {logLines.length === 0 ? (
                <div
                  style={{
                    color: '#86868b',
                    fontSize: 13,
                    lineHeight: 1.45,
                    paddingTop: 4,
                  }}
                >
                  {status === 'awaiting-focus'
                    ? 'Paste a paper, drop a PDF, drag an image, or describe what to draw. Then Send.'
                    : status === 'idle' && hasGenerated
                    ? 'Ready. Ask a follow-up below.'
                    : status === 'loading'
                    ? 'Loading…'
                    : 'Waiting for the agent…'}
                </div>
              ) : (
                groupIntoTurns(logLines).map((turn, i, arr) => (
                  <TurnGroup
                    key={i}
                    turn={turn}
                    isLastTurn={i === arr.length - 1}
                  />
                ))
              )}
            </div>

            <div
              style={{
                borderTop: '1px solid rgba(0,0,0,0.06)',
                padding: '10px 12px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: 'rgba(255,255,255,0.55)',
              }}
            >
              {attachments.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                  }}
                >
                  {attachments.map((a, i) => (
                    <span
                      key={`${a.absPath}-${i}`}
                      title={a.absPath}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        fontSize: 12,
                        color: '#1d1d1f',
                        background: 'rgba(10,132,255,0.10)',
                        border: '1px solid rgba(10,132,255,0.25)',
                        borderRadius: 7,
                        maxWidth: 200,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 500,
                          opacity: 0.7,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                        }}
                      >
                        {a.kind === 'image' ? 'IMG' : 'FILE'}
                      </span>
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.name}
                      </span>
                      <button
                        onClick={() => removeAttachment(i)}
                        aria-label={`Remove attachment ${a.name}`}
                        title="Remove"
                        style={{
                          marginLeft: 2,
                          padding: 0,
                          width: 16,
                          height: 16,
                          fontSize: 13,
                          lineHeight: '13px',
                          color: '#1d1d1f',
                          background: 'transparent',
                          border: 'none',
                          borderRadius: 4,
                          cursor: 'pointer',
                          opacity: 0.55,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.55')}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendOrGenerate();
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder={inputPlaceholder}
                  rows={1}
                  autoFocus={status === 'awaiting-focus'}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: '#1d1d1f',
                    background: 'rgba(255,255,255,0.9)',
                    border: '1px solid rgba(0,0,0,0.10)',
                    borderRadius: 9,
                    outline: 'none',
                    minWidth: 0,
                    minHeight: 34,
                    maxHeight: 144,
                    resize: 'none',
                    overflowY: 'auto',
                    transition: 'border-color 120ms ease, box-shadow 120ms ease',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(10,132,255,0.5)';
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(10,132,255,0.18)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                  onInput={(e) => {
                    // Autogrow: reset height, then snap to scrollHeight
                    // capped by CSS maxHeight. Pure DOM, no extra state.
                    const ta = e.currentTarget;
                    ta.style.height = 'auto';
                    ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`;
                  }}
                />
                <button
                  onClick={handleSendOrGenerate}
                  disabled={sendDisabled}
                  style={{
                    padding: '8px 14px',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    letterSpacing: '-0.005em',
                    background: sendDisabled
                      ? 'rgba(10,132,255,0.3)'
                      : '#0a84ff',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 9,
                    cursor: sendDisabled ? 'default' : 'pointer',
                    flexShrink: 0,
                    transition: 'background 120ms ease, transform 80ms ease',
                  }}
                  onMouseDown={(e) => {
                    if (!sendDisabled) e.currentTarget.style.transform = 'scale(0.97)';
                  }}
                  onMouseUp={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                  }}
                >
                  {buttonLabel}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
