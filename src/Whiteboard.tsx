import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { WhiteboardScene } from './types.js';

// Host interface — the parent app (Fathom) implements these and hands them in.
// Every method is per-call: no event subscriptions, no global stores.
export type WhiteboardHost = {
  // Returns { scene, mtimeMs } for the current paper, or null if none persisted.
  loadScene: () => Promise<{ scene: WhiteboardScene; mtimeMs: number } | null>;
  // Persists the given scene for the current paper.
  saveScene: (scene: WhiteboardScene) => Promise<void>;
  // Generates a brand-new scene from the paper. Calls `onScene` when the agent
  // emits an updated scene (streaming). Resolves with the final scene.
  generate: (cb: {
    onLog?: (s: string) => void;
    onScene?: (scene: WhiteboardScene) => void;
  }) => Promise<{ scene: WhiteboardScene; usd: number }>;
  // Applies a user chat instruction to the current scene.
  refine: (
    scene: WhiteboardScene,
    instruction: string,
    cb: {
      onLog?: (s: string) => void;
      onScene?: (scene: WhiteboardScene) => void;
    },
  ) => Promise<{ scene: WhiteboardScene; usd: number }>;
  // Optional: clear the persisted scene.
  clear?: () => Promise<void>;
};

type Props = {
  host: WhiteboardHost;
  // If true, auto-generate when no scene is persisted. Default: true.
  autoGenerate?: boolean;
};

export function Whiteboard({ host, autoGenerate = true }: Props) {
  const [scene, setScene] = useState<WhiteboardScene | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'generating' | 'refining' | 'error'>(
    'loading',
  );
  const [logLines, setLogLines] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const excalidrawApiRef = useRef<{ updateScene: (s: { elements: unknown[] }) => void } | null>(
    null,
  );

  const log = (line: string) => {
    setLogLines((prev) => [...prev.slice(-99), line]);
  };

  const onSceneFromAgent = (next: WhiteboardScene) => {
    setScene(next);
    if (excalidrawApiRef.current) {
      excalidrawApiRef.current.updateScene({ elements: next.elements });
    }
  };

  // Initial load — try host.loadScene(), else auto-generate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persisted = await host.loadScene();
        if (cancelled) return;
        if (persisted && persisted.scene.elements.length > 0) {
          setScene(persisted.scene);
          setStatus('idle');
          return;
        }
        if (autoGenerate) {
          setStatus('generating');
          const { scene: fresh } = await host.generate({ onLog: log, onScene: onSceneFromAgent });
          if (cancelled) return;
          setScene(fresh);
          await host.saveScene(fresh);
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
    };
  }, [host, autoGenerate]);

  const handleChatSend = async () => {
    const instruction = chatInput.trim();
    if (!instruction || !scene) return;
    setChatInput('');
    setStatus('refining');
    try {
      const { scene: next } = await host.refine(scene, instruction, {
        onLog: log,
        onScene: onSceneFromAgent,
      });
      setScene(next);
      await host.saveScene(next);
      setStatus('idle');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus('error');
    }
  };

  const initialData = useMemo(
    () =>
      scene
        ? {
            elements: scene.elements as never,
            appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 } as never,
          }
        : null,
    [scene],
  );

  const busy = status === 'generating' || status === 'refining';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {scene && initialData ? (
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={(api) => {
              excalidrawApiRef.current = api as unknown as {
                updateScene: (s: { elements: unknown[] }) => void;
              };
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#666',
              fontFamily: 'system-ui',
            }}
          >
            {status === 'loading' && 'Loading whiteboard…'}
            {status === 'generating' && 'Generating whiteboard from paper…'}
            {status === 'error' && (
              <div style={{ color: '#c00', maxWidth: 480, textAlign: 'center' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Whiteboard failed</div>
                <div style={{ fontSize: 13 }}>{errorMsg}</div>
              </div>
            )}
          </div>
        )}
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
            }}
          >
            {status === 'generating' ? 'Generating…' : 'Refining…'}
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
            scene
              ? 'Refine the whiteboard… (e.g. "add the loss equation", "zoom into the cross-attention block")'
              : 'Whiteboard will be generated first…'
          }
          disabled={!scene || busy}
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
          disabled={!scene || busy || !chatInput.trim()}
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
