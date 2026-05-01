import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Whiteboard } from '../../src/Whiteboard.js';
import type {
  WhiteboardHost,
  WhiteboardScene,
  WhiteboardViewport,
} from '../../src/Whiteboard.js';

// The shape exposed by preload's contextBridge.
type WbApi = {
  paper: {
    load: () => Promise<PaperPayload | null>;
    save: (p: PaperPayload) => Promise<void>;
    clear: () => Promise<void>;
  };
  asset: {
    save: (filename: string, bytes: ArrayBuffer) => Promise<{ absPath: string }>;
  };
  scene: {
    load: () => Promise<{ elements: unknown[] } | null>;
    save: (s: { elements: unknown[] }) => Promise<void>;
  };
  viewport: {
    load: () => Promise<WhiteboardViewport | null>;
    save: (vp: WhiteboardViewport) => Promise<void>;
  };
  generate: (
    req: { paper: PaperPayload; focus?: string },
    cb: {
      onLog?: (s: string) => void;
      onScene?: (elements: unknown[]) => void;
      onDone?: (info: { elements: unknown[]; usd: number; turns: number }) => void;
      onError?: (msg: string) => void;
    },
  ) => Promise<{ channel: string }>;
  refine: (
    req: { paper: PaperPayload; scene: { elements: unknown[] }; instruction: string },
    cb: {
      onLog?: (s: string) => void;
      onScene?: (elements: unknown[]) => void;
      onDone?: (info: { elements: unknown[] }) => void;
      onError?: (msg: string) => void;
    },
  ) => Promise<{ channel: string }>;
  abort: (channel: string) => Promise<void>;
};

declare global {
  interface Window {
    wb: WbApi;
  }
}

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

// ---------- root ----------
//
// One surface: the Whiteboard. The right side panel is the only entry
// point — the user pastes text, drops a PDF, drags an image, or just
// types a request. The first Send turns whatever they pasted/typed into
// the "paper" that grounds the canvas. Subsequent Sends are refinements.
//
// We keep the legacy `paper` notion in IPC for persistence + pipeline
// compatibility, but the user never sees a separate "paste your content
// first" step anymore.

function deriveTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? '';
  return firstLine.length > 0 && firstLine.length < 100 ? firstLine : 'Brainstorm';
}

function synthesizePaper(composed: string): PaperPayload {
  const trimmed = composed.trim();
  // The chat's `composed` already includes attachment markdown
  // (`![attached image: …](abs path)` / `[attached file: …](abs path)`),
  // so the agent sees inline references it can Read. We always emit a
  // text-kind paper; the path-kind branch in pipeline.ts is reserved
  // for the embedded-in-Fathom case where a real PDF is the paper.
  return {
    kind: 'text',
    markdown: trimmed.length > 0 ? trimmed : 'Brainstorm.',
    title: deriveTitle(trimmed),
  };
}

export function App() {
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [paperLoaded, setPaperLoaded] = useState(false);
  const [resetCount, setResetCount] = useState(0);

  // Stable mirror of `paper` so the host (built once) can read the
  // latest value without being reconstructed on every state change.
  // Reconstructing the host would re-run Whiteboard's loadScene effect
  // and cancel any in-flight generation.
  const paperRef = useRef<PaperPayload | null>(null);

  useEffect(() => {
    paperRef.current = paper;
  }, [paper]);

  useEffect(() => {
    void window.wb.paper.load().then((p) => {
      if (p) {
        paperRef.current = p;
        setPaper(p);
      }
      setPaperLoaded(true);
    });
  }, []);

  const host = useMemo<WhiteboardHost>(
    () => ({
      loadScene: async () => {
        const s = await window.wb.scene.load();
        if (!s) return null;
        return {
          scene: { elements: s.elements as WhiteboardScene['elements'] },
          mtimeMs: 0,
        };
      },
      saveScene: async (s) => {
        await window.wb.scene.save({ elements: s.elements });
      },
      loadViewport: () => window.wb.viewport.load(),
      saveViewport: (vp) => window.wb.viewport.save(vp),
      saveAsset: (filename, bytes) => window.wb.asset.save(filename, bytes),
      generate: (cb, focus, abortController) =>
        new Promise((resolve, reject) => {
          // First Send (no paper yet): the chat content IS the paper.
          // Synthesize, persist, then drive the pipeline.
          let activePaper = paperRef.current;
          let activeFocus: string | undefined = focus;
          if (!activePaper) {
            activePaper = synthesizePaper(focus ?? '');
            paperRef.current = activePaper;
            setPaper(activePaper);
            void window.wb.paper.save(activePaper);
            // The composed chat is now the paper body — don't double it
            // up by also passing it as `focus`.
            activeFocus = undefined;
          }

          void window.wb
            .generate(
              { paper: activePaper, focus: activeFocus },
              {
                onLog: cb.onLog,
                onScene: (elements) =>
                  cb.onScene?.({
                    elements: elements as WhiteboardScene['elements'],
                  }),
                onDone: (info) =>
                  resolve({
                    scene: {
                      elements: info.elements as WhiteboardScene['elements'],
                    },
                    usd: info.usd,
                  }),
                onError: (msg) => reject(new Error(msg)),
              },
            )
            .then(({ channel }) => {
              if (abortController) {
                if (abortController.signal.aborted) {
                  void window.wb.abort(channel);
                } else {
                  abortController.signal.addEventListener(
                    'abort',
                    () => {
                      void window.wb.abort(channel);
                    },
                    { once: true },
                  );
                }
              }
            });
        }),
      refine: (scene, instruction, cb, abortController) =>
        new Promise((resolve, reject) => {
          const activePaper = paperRef.current;
          if (!activePaper) {
            // Refine without an established paper shouldn't be reachable
            // (Whiteboard only enables refine after hasGenerated). If it
            // happens, fall back to treating the instruction as initial
            // content rather than failing silently.
            reject(new Error('No paper established yet — use generate.'));
            return;
          }
          void window.wb
            .refine(
              { paper: activePaper, scene: { elements: scene.elements }, instruction },
              {
                onLog: cb.onLog,
                onScene: (elements) =>
                  cb.onScene?.({
                    elements: elements as WhiteboardScene['elements'],
                  }),
                onDone: (info) =>
                  resolve({
                    scene: {
                      elements: info.elements as WhiteboardScene['elements'],
                    },
                    usd: 0,
                  }),
                onError: (msg) => reject(new Error(msg)),
              },
            )
            .then(({ channel }) => {
              if (abortController) {
                if (abortController.signal.aborted) {
                  void window.wb.abort(channel);
                } else {
                  abortController.signal.addEventListener(
                    'abort',
                    () => {
                      void window.wb.abort(channel);
                    },
                    { once: true },
                  );
                }
              }
            });
        }),
      clear: async () => {
        await window.wb.paper.clear();
        await window.wb.scene.save({ elements: [] });
        paperRef.current = null;
        setPaper(null);
        // Bump the key to force-remount Whiteboard so its internal
        // status/scene state resets.
        setResetCount((n) => n + 1);
      },
    }),
    [],
  );

  if (!paperLoaded) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#86868b',
          fontSize: 13,
        }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar
        title={paper?.title ?? 'Slate'}
        onNew={() => {
          void host.clear?.();
        }}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <Whiteboard host={host} key={resetCount} />
      </div>
    </div>
  );
}

function TopBar({ title, onNew }: { title: string; onNew: () => void }) {
  return (
    <div
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 14px 0 86px', // leave room for traffic-light buttons
        background: 'rgba(245,245,247,0.8)',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        WebkitAppRegion: 'drag' as never,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: '#1d1d1f',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 500,
        }}
      >
        {title}
      </div>
      <button
        onClick={onNew}
        style={{
          WebkitAppRegion: 'no-drag' as never,
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 500,
          fontFamily: 'inherit',
          color: '#0a84ff',
          background: 'transparent',
          border: '1px solid rgba(10,132,255,0.3)',
          borderRadius: 7,
          cursor: 'pointer',
        }}
      >
        New
      </button>
    </div>
  );
}
