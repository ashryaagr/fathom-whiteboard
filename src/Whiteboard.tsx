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
  const [savedToast, setSavedToast] = useState(false);
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
                    ? 'Tell the agent what to focus on, or leave blank for a general overview.'
                    : status === 'idle' && hasGenerated
                    ? 'Ready. Ask a follow-up below.'
                    : status === 'loading'
                    ? 'Loading…'
                    : 'Waiting for the agent…'}
                </div>
              ) : (
                logLines.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      marginBottom: 3,
                      // Slight emphasis on the freshest line for
                      // readability without making older lines noise.
                      color: i === logLines.length - 1 ? '#1d1d1f' : '#3a3a3c',
                      fontFamily:
                        line.startsWith('[tool_use]') || line.startsWith('[result]')
                          ? "ui-monospace, 'SF Mono', Menlo, monospace"
                          : 'inherit',
                      fontSize:
                        line.startsWith('[tool_use]') || line.startsWith('[result]')
                          ? 11
                          : 12,
                    }}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                borderTop: '1px solid rgba(0,0,0,0.06)',
                padding: '10px 12px 12px',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                background: 'rgba(255,255,255,0.55)',
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
                  padding: '8px 12px',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: '#1d1d1f',
                  background: 'rgba(255,255,255,0.9)',
                  border: '1px solid rgba(0,0,0,0.10)',
                  borderRadius: 9,
                  outline: 'none',
                  minWidth: 0,
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
          </>
        )}
      </div>
    </div>
  );
}
