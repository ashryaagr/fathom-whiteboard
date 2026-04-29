import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { WhiteboardScene, WhiteboardViewport } from './types.js';

// Host interface — the parent app (Fathom) implements these and hands them in.
// Every method is per-call: no event subscriptions, no global stores.
export type WhiteboardHost = {
  loadScene: () => Promise<{ scene: WhiteboardScene; mtimeMs: number } | null>;
  saveScene: (scene: WhiteboardScene) => Promise<void>;
  // Optional viewport persistence. If implemented, the component will
  // restore the saved pan/zoom on mount and persist the viewport (with
  // ~250ms debounce) as the user pans + zooms. Hosts that don't care
  // about per-paper viewport memory can omit these.
  loadViewport?: () => Promise<WhiteboardViewport | null>;
  saveViewport?: (viewport: WhiteboardViewport) => Promise<void>;
  generate: (cb: {
    onLog?: (s: string) => void;
    onScene?: (scene: WhiteboardScene) => void;
  }) => Promise<{ scene: WhiteboardScene; usd: number }>;
  refine: (
    scene: WhiteboardScene,
    instruction: string,
    cb: {
      onLog?: (s: string) => void;
      onScene?: (scene: WhiteboardScene) => void;
    },
  ) => Promise<{ scene: WhiteboardScene; usd: number }>;
  clear?: () => Promise<void>;
};

type Props = {
  host: WhiteboardHost;
  autoGenerate?: boolean;
};

// Minimal subset of @excalidraw/excalidraw's API we touch. Kept here so
// we don't drag the editor's full type surface into our props.
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

export function Whiteboard({ host, autoGenerate = true }: Props) {
  // Mount Excalidraw on first render with an empty scene so we can
  // call updateScene() the moment the agent emits its first
  // create_view tool call. If we waited for `scene !== null`, the
  // editor wouldn't be on the DOM during streaming and the user would
  // stare at a placeholder for the whole generation.
  const [hasGenerated, setHasGenerated] = useState(false);
  const [status, setStatus] = useState<'loading' | 'idle' | 'generating' | 'refining' | 'error'>(
    'loading',
  );
  const [logLines, setLogLines] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  // Latest scene the agent emitted. We keep it in a ref because
  // chat-refinement needs to send the current state synchronously.
  const sceneRef = useRef<WhiteboardScene>({ elements: [] });
  const logFeedRef = useRef<HTMLDivElement | null>(null);

  // Viewport plumbing.
  const pendingInitialViewportRef = useRef<WhiteboardViewport | null>(null);
  const didAutoFitRef = useRef(false);
  const lastSavedViewportRef = useRef<WhiteboardViewport | null>(null);
  const saveViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Streaming auto-save plumbing. Every applySceneToCanvas call schedules a
  // debounced flush so the partial scene survives a crash mid-generation.
  // We also save immediately on completion. 800ms strikes a balance: fast
  // enough that a crash loses ≤1 frame of progress, slow enough that
  // back-to-back create_view emits coalesce into one disk write.
  const saveSceneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const log = (line: string) => {
    setLogLines((prev) => [...prev.slice(-199), line]);
  };

  // Auto-scroll the log feed to the bottom whenever a new line lands —
  // the panel is a "what's happening continuously" surface, so the
  // freshest line should always be visible without the user scrolling.
  useEffect(() => {
    const el = logFeedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const flushSaveScene = (scene: WhiteboardScene) => {
    if (scene.elements.length === 0) return;
    void host.saveScene(scene).catch(() => {
      /* next streaming snapshot will retry */
    });
  };

  const scheduleStreamingSave = (scene: WhiteboardScene) => {
    if (saveSceneTimerRef.current) clearTimeout(saveSceneTimerRef.current);
    saveSceneTimerRef.current = setTimeout(() => flushSaveScene(scene), 800);
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

  const applySceneToCanvas = (next: WhiteboardScene) => {
    sceneRef.current = next;
    setHasGenerated(true);
    if (apiRef.current) {
      apiRef.current.updateScene({ elements: next.elements });
    }
    // Streaming auto-save: a crash mid-generation should never lose
    // progress the user has already watched land on the canvas.
    scheduleStreamingSave(next);
  };

  // Initial load — try host.loadScene(); auto-generate if absent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const viewportPromise = host.loadViewport
          ? host.loadViewport().catch(() => null)
          : Promise.resolve(null);

        const persisted = await host.loadScene();
        if (cancelled) return;

        const persistedViewport = await viewportPromise;
        if (cancelled) return;

        if (persisted && persisted.scene.elements.length > 0) {
          // Direct assign, not applySceneToCanvas — we don't want to
          // re-save a scene we just loaded from disk.
          sceneRef.current = persisted.scene;
          setHasGenerated(true);
          if (apiRef.current) {
            apiRef.current.updateScene({ elements: persisted.scene.elements });
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
        if (autoGenerate) {
          setStatus('generating');
          const { scene: fresh } = await host.generate({
            onLog: log,
            onScene: applySceneToCanvas,
          });
          if (cancelled) return;
          applySceneToCanvas(fresh);
          // Cancel any pending streaming flush — we're about to fire
          // the immediate completion save.
          if (saveSceneTimerRef.current) {
            clearTimeout(saveSceneTimerRef.current);
            saveSceneTimerRef.current = null;
          }
          await host.saveScene(fresh);
          queueMicrotask(autoFitToContent);
          setStatus('idle');
        } else {
          setStatus('idle');
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMsg((err as Error).message);
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
        // Best-effort flush on unmount: if a save is pending, fire it
        // synchronously rather than letting it cancel.
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
        flushSaveScene(sceneRef.current);
      }
    };
  }, [host, autoGenerate]);

  const handleChatSend = async () => {
    const instruction = chatInput.trim();
    if (!instruction || !hasGenerated) return;
    setChatInput('');
    setStatus('refining');
    try {
      const { scene: next } = await host.refine(sceneRef.current, instruction, {
        onLog: log,
        onScene: applySceneToCanvas,
      });
      applySceneToCanvas(next);
      if (saveSceneTimerRef.current) {
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
      }
      await host.saveScene(next);
      setStatus('idle');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus('error');
    }
  };

  const handleExcalidrawChange = (
    _elements: readonly unknown[],
    appState: ExcalidrawAppState,
  ) => {
    if (!host.saveViewport) return;
    const vp = readViewport(appState);
    if (viewportEqual(lastSavedViewportRef.current, vp)) return;
    if (saveViewportTimerRef.current) clearTimeout(saveViewportTimerRef.current);
    saveViewportTimerRef.current = setTimeout(() => {
      if (viewportEqual(lastSavedViewportRef.current, vp)) return;
      lastSavedViewportRef.current = vp;
      void host.saveViewport!(vp).catch(() => {
        /* next pan will retry */
      });
    }, 250);
  };

  const busy = status === 'generating' || status === 'refining';
  const sidePanelWidth = panelCollapsed ? SIDE_PANEL_COLLAPSED_WIDTH : SIDE_PANEL_WIDTH;

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%' }}>
      {/* Left column: Excalidraw fills the remaining width. */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
        <Excalidraw
          initialData={{
            elements: [] as never,
            appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 } as never,
          }}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as ExcalidrawApi;
            if (sceneRef.current.elements.length > 0) {
              apiRef.current.updateScene({ elements: sceneRef.current.elements });
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

      {/* Right side panel — collapsible. Shows agent activity (log
          stream) on top + chat input at the bottom. The user lives
          here while the diagram builds; they pan/zoom on the canvas
          and ask follow-ups in the panel. */}
      <div
        style={{
          width: sidePanelWidth,
          borderLeft: '1px solid #e5e5e5',
          background: '#fafafa',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          transition: 'width 180ms ease',
          flexShrink: 0,
        }}
      >
        {panelCollapsed ? (
          <button
            onClick={() => setPanelCollapsed(false)}
            title="Show activity panel"
            aria-label="Show activity panel"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 14,
              color: '#666',
              fontFamily: 'system-ui',
              writingMode: 'vertical-rl',
              padding: '12px 0',
            }}
          >
            ‹ Activity
          </button>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                borderBottom: '1px solid #e5e5e5',
                fontFamily: 'system-ui',
                fontSize: 12,
                color: '#666',
              }}
            >
              <span style={{ fontWeight: 600 }}>
                {status === 'generating'
                  ? 'Generating…'
                  : status === 'refining'
                  ? 'Refining…'
                  : status === 'loading'
                  ? 'Loading…'
                  : status === 'error'
                  ? 'Error'
                  : 'Activity'}
              </span>
              <button
                onClick={() => setPanelCollapsed(true)}
                title="Collapse"
                aria-label="Collapse activity panel"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 14,
                  color: '#666',
                  padding: '0 4px',
                }}
              >
                ›
              </button>
            </div>

            {/* Log feed — auto-scrolling stream of agent activity
                (assistant text, tool_use names, internal logs). */}
            <div
              ref={logFeedRef}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px 10px',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 11,
                color: '#444',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {logLines.length === 0 ? (
                <div
                  style={{
                    color: '#999',
                    fontFamily: 'system-ui',
                    fontStyle: 'italic',
                  }}
                >
                  {status === 'idle' && hasGenerated
                    ? 'Whiteboard ready. Ask a follow-up below.'
                    : 'Waiting for agent activity…'}
                </div>
              ) : (
                logLines.map((line, i) => (
                  <div key={i} style={{ marginBottom: 2 }}>
                    {line}
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                borderTop: '1px solid #e5e5e5',
                padding: 8,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                background: '#fff',
              }}
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
                placeholder={hasGenerated ? 'Refine the whiteboard…' : 'Generating…'}
                disabled={!hasGenerated || busy}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  fontFamily: 'system-ui',
                  fontSize: 13,
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  minWidth: 0,
                }}
              />
              <button
                onClick={handleChatSend}
                disabled={!hasGenerated || busy || !chatInput.trim()}
                style={{
                  padding: '6px 10px',
                  fontFamily: 'system-ui',
                  fontSize: 13,
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  background: '#fff',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
