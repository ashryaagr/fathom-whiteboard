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
  const apiRef = useRef<ExcalidrawApi | null>(null);
  // Latest scene the agent emitted. We keep it in a ref because
  // chat-refinement needs to send the current state synchronously.
  const sceneRef = useRef<WhiteboardScene>({ elements: [] });

  // Viewport plumbing.
  // - `pendingInitialViewport` holds a viewport returned by host.loadViewport()
  //   before the Excalidraw API is ready; we apply it as soon as the API
  //   binds.
  // - `didAutoFit` records whether we've already auto-scrolled-to-content
  //   for this paper. We auto-fit ONCE per paper, the first time generation
  //   produces a non-empty scene AND there is no persisted viewport. We
  //   never re-fit on subsequent renders, sidecar hydrations, or chat
  //   refinements — that would fight the user's manual pan/zoom.
  // - `lastSavedViewportRef` is the last viewport we wrote to disk; we
  //   compare against it to suppress redundant saves.
  const pendingInitialViewportRef = useRef<WhiteboardViewport | null>(null);
  const didAutoFitRef = useRef(false);
  const lastSavedViewportRef = useRef<WhiteboardViewport | null>(null);
  const saveViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const log = (line: string) => {
    setLogLines((prev) => [...prev.slice(-99), line]);
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
      // Push the elements array onto the live Excalidraw scene. This
      // is the streaming path: every create_view tool_use the agent
      // emits triggers a fresh updateScene() call here, so the user
      // watches the diagram build progressively rather than blink in
      // at the end.
      apiRef.current.updateScene({ elements: next.elements });
    }
  };

  // Initial load — try host.loadScene(); auto-generate if absent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Kick the viewport load in parallel with the scene load — they
        // both come from the host's persistence layer and are
        // independent. Whichever resolves first updates state; the
        // canvas applies the viewport once the API is ready.
        const viewportPromise = host.loadViewport
          ? host.loadViewport().catch(() => null)
          : Promise.resolve(null);

        const persisted = await host.loadScene();
        if (cancelled) return;

        const persistedViewport = await viewportPromise;
        if (cancelled) return;

        if (persisted && persisted.scene.elements.length > 0) {
          applySceneToCanvas(persisted.scene);
          if (persistedViewport) {
            // Existing whiteboard with saved viewport — restore where
            // the user left off, and DON'T auto-fit (user already
            // chose this view).
            applyViewportToCanvas(persistedViewport);
            didAutoFitRef.current = true;
          } else {
            // Existing whiteboard without saved viewport (first reopen
            // since this feature shipped, or the viewport file got
            // lost). Auto-fit once so the user lands on content.
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
          await host.saveScene(fresh);
          // First-ever generation for this paper — auto-scroll to the
          // generated content so the user doesn't have to hunt for it.
          // queueMicrotask gives Excalidraw one tick to finish laying
          // the scene out before scrollToContent measures bboxes.
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
      await host.saveScene(next);
      setStatus('idle');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus('error');
    }
  };

  // Excalidraw fires onChange on EVERY interaction (pan, zoom, edit,
  // selection, hover-over-tool). We only care about pan + zoom. The
  // 250ms debounce + the viewport-equality check below mean we hit
  // disk at most ~4 times/sec while the user is actively panning, and
  // not at all while they're idle.
  const handleExcalidrawChange = (
    _elements: readonly unknown[],
    appState: ExcalidrawAppState,
  ) => {
    if (!host.saveViewport) return;
    const vp = readViewport(appState);
    if (viewportEqual(lastSavedViewportRef.current, vp)) return;
    if (saveViewportTimerRef.current) clearTimeout(saveViewportTimerRef.current);
    saveViewportTimerRef.current = setTimeout(() => {
      // Re-check at flush time in case the user resettled at the
      // previously-saved viewport during the debounce window.
      if (viewportEqual(lastSavedViewportRef.current, vp)) return;
      lastSavedViewportRef.current = vp;
      void host.saveViewport!(vp).catch(() => {
        /* swallow — next pan will retry */
      });
    }, 250);
  };

  const busy = status === 'generating' || status === 'refining';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {/*
          Excalidraw mounts immediately on first render so the
          streaming path can call `apiRef.current.updateScene()` for
          every partial scene snapshot. The empty `initialData` is
          replaced live; we never re-mount the editor across the
          generation.
        */}
        <Excalidraw
          initialData={{
            elements: [] as never,
            appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 } as never,
          }}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as ExcalidrawApi;
            // If a load-from-disk scene came back before the API was
            // ready, replay it now that we have the API.
            if (sceneRef.current.elements.length > 0) {
              apiRef.current.updateScene({ elements: sceneRef.current.elements });
            }
            // Same for the viewport — if loadViewport resolved before
            // the API was here, apply it now.
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
              right: 8,
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
      <div
        style={{
          borderTop: '1px solid #e5e5e5',
          padding: 8,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: '#fafafa',
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
          placeholder={
            hasGenerated
              ? 'Refine the whiteboard… (e.g. "add the loss equation", "zoom into cross-attention")'
              : 'Whiteboard will be generated first…'
          }
          disabled={!hasGenerated || busy}
          style={{
            flex: 1,
            padding: '8px 10px',
            fontFamily: 'system-ui',
            fontSize: 14,
            border: '1px solid #ccc',
            borderRadius: 4,
          }}
        />
        <button
          onClick={handleChatSend}
          disabled={!hasGenerated || busy || !chatInput.trim()}
          style={{
            padding: '8px 14px',
            fontFamily: 'system-ui',
            fontSize: 14,
            border: '1px solid #ccc',
            borderRadius: 4,
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          Send
        </button>
      </div>
      {logLines.length > 0 && (
        <details style={{ borderTop: '1px solid #eee', padding: '4px 8px', background: '#fafafa' }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#888', fontFamily: 'system-ui' }}>
            Agent log ({logLines.length})
          </summary>
          <pre
            style={{
              maxHeight: 120,
              overflow: 'auto',
              fontSize: 11,
              fontFamily: 'ui-monospace, Menlo, monospace',
              margin: 4,
              color: '#666',
            }}
          >
            {logLines.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
