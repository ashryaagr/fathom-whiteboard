import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { WhiteboardScene, WhiteboardViewport } from './types.js';

// Host interface — the parent app (Fathom) implements these and hands them in.
// Every method is per-call: no event subscriptions, no global stores.
export type WhiteboardHost = {
  loadScene: () => Promise<{ scene: WhiteboardScene; mtimeMs: number } | null>;
  saveScene: (scene: WhiteboardScene) => Promise<void>;
  loadViewport?: () => Promise<WhiteboardViewport | null>;
  saveViewport?: (viewport: WhiteboardViewport) => Promise<void>;
  // generate optionally accepts a `focus` string the user typed before
  // kicking off generation. The host should thread it down to the
  // pipeline so it appears in the system message.
  generate: (
    cb: {
      onLog?: (s: string) => void;
      onScene?: (scene: WhiteboardScene) => void;
    },
    focus?: string,
  ) => Promise<{ scene: WhiteboardScene; usd: number }>;
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
// 400ms debounce on every save path. Tight enough that a tab close /
// crash loses ≤1 frame of pan, zoom, or edit; loose enough that a
// burst of agent emits or rapid panning coalesces into a single write.
const SAVE_DEBOUNCE_MS = 400;

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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
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
    setLogLines((prev) => [...prev.slice(-199), line]);
  };

  useEffect(() => {
    const el = logFeedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const flushSaveScene = (scene: WhiteboardScene) => {
    if (!canSaveRef.current) return;
    if (scene.elements.length === 0) return;
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
  const applySceneToCanvas = (next: WhiteboardScene) => {
    sceneRef.current = next;
    setHasGenerated(true);
    canSaveRef.current = true;
    if (apiRef.current) {
      apiRef.current.updateScene({ elements: next.elements });
    }
  };

  const startGeneration = async (focusText: string) => {
    setStatus('generating');
    try {
      const { scene: fresh } = await host.generate(
        {
          onLog: log,
          onScene: applySceneToCanvas,
        },
        focusText.trim() || undefined,
      );
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
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus('error');
    }
  };

  // Initial load — try host.loadScene(); if absent, surface the focus
  // prompt UI rather than auto-generating. The user gets to specify
  // what the diagram should foreground before we burn the API spend.
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
          sceneRef.current = persisted.scene;
          setHasGenerated(true);
          canSaveRef.current = true;
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
        // No persisted scene → wait for the user to type a focus
        // prompt and click Generate.
        setStatus('awaiting-focus');
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
        // synchronously so closing the tab doesn't lose the latest.
        clearTimeout(saveSceneTimerRef.current);
        saveSceneTimerRef.current = null;
        flushSaveScene(sceneRef.current);
      }
    };
  }, [host]);

  const handleSendOrGenerate = async () => {
    const text = chatInput.trim();
    if (status === 'awaiting-focus') {
      setChatInput('');
      await startGeneration(text);
      return;
    }
    if (!hasGenerated || !text) return;
    setChatInput('');
    setStatus('refining');
    try {
      const { scene: next } = await host.refine(sceneRef.current, text, {
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

  // Input + button affordances depend on what the panel is asking
  // for. Three modes: generation gate (awaiting-focus), refine
  // (idle/post-generation), nothing-to-do (loading/error).
  let inputPlaceholder = 'Generating…';
  let buttonLabel = 'Send';
  let inputDisabled = busy || status === 'loading' || status === 'error';
  if (status === 'awaiting-focus') {
    inputPlaceholder = 'What should the whiteboard focus on? (optional — Enter for general overview)';
    buttonLabel = 'Generate';
    inputDisabled = false;
  } else if (status === 'idle' && hasGenerated) {
    inputPlaceholder = 'Refine the whiteboard…';
    buttonLabel = 'Send';
  }
  const sendDisabled =
    inputDisabled ||
    (status !== 'awaiting-focus' && (!hasGenerated || !chatInput.trim()));

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
                No whiteboard yet
              </div>
              <div>Type a focus on the right (optional) and click Generate.</div>
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
                  : status === 'awaiting-focus'
                  ? 'Ready to generate'
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
                  {status === 'awaiting-focus'
                    ? 'Type what you want the whiteboard to focus on (or leave blank), then click Generate.'
                    : status === 'idle' && hasGenerated
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
                    handleSendOrGenerate();
                  }
                }}
                placeholder={inputPlaceholder}
                disabled={inputDisabled}
                autoFocus={status === 'awaiting-focus'}
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
                onClick={handleSendOrGenerate}
                disabled={sendDisabled}
                style={{
                  padding: '6px 10px',
                  fontFamily: 'system-ui',
                  fontSize: 13,
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  background: status === 'awaiting-focus' ? '#1d4ed8' : '#fff',
                  color: status === 'awaiting-focus' ? '#fff' : '#000',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {buttonLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
