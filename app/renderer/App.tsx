import React, { useCallback, useEffect, useRef, useState } from 'react';
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
};

declare global {
  interface Window {
    wb: WbApi;
  }
}

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

// ---------- paste handling ----------

async function paperFromClipboard(
  e: React.ClipboardEvent<HTMLDivElement>,
): Promise<PaperPayload | null> {
  const dt = e.clipboardData;
  if (!dt) return null;

  // 1. File first (PDF or image attachment from Finder/Mail)
  const files = Array.from(dt.files);
  if (files.length > 0) {
    const f = files[0];
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      const ab = await f.arrayBuffer();
      const { absPath } = await window.wb.asset.save(f.name, ab);
      return { kind: 'path', absPath, title: f.name.replace(/\.pdf$/i, '') };
    }
    if (f.type.startsWith('image/')) {
      const ab = await f.arrayBuffer();
      const { absPath } = await window.wb.asset.save(f.name || 'image.png', ab);
      // Wrap image as a synthetic paper. The agent's Read tool can
      // open PNG/JPG natively (Claude reads images as visual input).
      return {
        kind: 'text',
        title: 'Pasted image',
        markdown: `# Pasted image\n\n![image](${absPath})\n\nThe image is saved at ${absPath}. Use your Read tool on it to see it.`,
      };
    }
  }

  // 2. Text (the most common path: pasted from a paper/abstract/notes)
  const text = dt.getData('text/plain');
  if (text && text.trim().length > 0) {
    const firstLine = text.trim().split(/\r?\n/)[0];
    const title =
      firstLine.length > 0 && firstLine.length < 100 ? firstLine : 'Brainstorm';
    return { kind: 'text', markdown: text, title };
  }

  return null;
}

async function paperFromDrop(e: React.DragEvent<HTMLDivElement>): Promise<
  PaperPayload | null
> {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const files = Array.from(dt.files);
  if (files.length > 0) {
    const f = files[0];
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      const ab = await f.arrayBuffer();
      const { absPath } = await window.wb.asset.save(f.name, ab);
      return { kind: 'path', absPath, title: f.name.replace(/\.pdf$/i, '') };
    }
    if (f.type.startsWith('image/')) {
      const ab = await f.arrayBuffer();
      const { absPath } = await window.wb.asset.save(f.name || 'image.png', ab);
      return {
        kind: 'text',
        title: 'Pasted image',
        markdown: `# Pasted image\n\n![image](${absPath})\n\nThe image is saved at ${absPath}.`,
      };
    }
  }
  const text = dt.getData('text/plain');
  if (text && text.trim().length > 0) {
    return { kind: 'text', markdown: text, title: 'Brainstorm' };
  }
  return null;
}

// ---------- landing screen ----------

function Landing({
  onPaper,
}: {
  onPaper: (p: PaperPayload) => void;
}) {
  const [textValue, setTextValue] = useState('');
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submitText = () => {
    if (!textValue.trim()) return;
    const firstLine = textValue.trim().split(/\r?\n/)[0];
    onPaper({
      kind: 'text',
      markdown: textValue,
      title: firstLine.length > 0 && firstLine.length < 100 ? firstLine : 'Brainstorm',
    });
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const p = await paperFromClipboard(e);
    if (p) {
      e.preventDefault();
      onPaper(p);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    const p = await paperFromDrop(e);
    if (p) onPaper(p);
  };

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(1200px 800px at 50% -10%, #ffffff 0%, #f5f5f7 50%, #ececef 100%)',
        WebkitAppRegion: 'drag' as never,
      }}
    >
      <div
        ref={inputRef}
        tabIndex={0}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        style={{
          WebkitAppRegion: 'no-drag' as never,
          width: 580,
          maxWidth: '92%',
          padding: 28,
          borderRadius: 18,
          background: hover ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.78)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
          boxShadow: hover
            ? '0 24px 60px rgba(0,0,0,0.10), 0 0 0 4px rgba(0,122,255,0.18)'
            : '0 24px 60px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
          border: '1px solid rgba(0,0,0,0.06)',
          transition: 'box-shadow 180ms ease, background 180ms ease',
          outline: 'none',
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: '#1d1d1f',
            marginBottom: 6,
          }}
        >
          Whiteboard
        </div>
        <div
          style={{
            fontSize: 13,
            color: '#6e6e73',
            lineHeight: 1.5,
            marginBottom: 22,
          }}
        >
          Paste anything — text, an abstract, an image, a PDF — and brainstorm
          with an agent on a live whiteboard. ⌘V or drag in.
        </div>
        <textarea
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          placeholder="Paste or type here…"
          rows={6}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px 14px',
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: 'inherit',
            color: '#1d1d1f',
            background: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(0,0,0,0.10)',
            borderRadius: 12,
            outline: 'none',
            resize: 'vertical',
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submitText();
            }
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
          }}
        >
          <div style={{ fontSize: 12, color: '#86868b' }}>
            ⌘ + Return to start
          </div>
          <button
            onClick={submitText}
            disabled={!textValue.trim()}
            style={{
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: '#fff',
              background: textValue.trim() ? '#0a84ff' : 'rgba(10,132,255,0.3)',
              border: 'none',
              borderRadius: 8,
              cursor: textValue.trim() ? 'pointer' : 'default',
              transition: 'background 120ms ease',
            }}
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- root ----------

export function App() {
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [paperLoaded, setPaperLoaded] = useState(false);

  useEffect(() => {
    void window.wb.paper.load().then((p) => {
      if (p) setPaper(p);
      setPaperLoaded(true);
    });
  }, []);

  const onPaper = useCallback((p: PaperPayload) => {
    setPaper(p);
    void window.wb.paper.save(p);
  }, []);

  // Build a Whiteboard host bound to the current paper. Recreated
  // when paper changes (so the package's internal load/restore re-runs
  // against the new content).
  const host: WhiteboardHost | null = paper
    ? {
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
        generate: (cb, focus) =>
          new Promise((resolve, reject) => {
            void window.wb.generate(
              { paper, focus },
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
            );
          }),
        refine: (scene, instruction, cb) =>
          new Promise((resolve, reject) => {
            void window.wb.refine(
              { paper, scene: { elements: scene.elements }, instruction },
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
            );
          }),
        clear: async () => {
          await window.wb.paper.clear();
          setPaper(null);
        },
      }
    : null;

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

  if (!paper || !host) {
    return <Landing onPaper={onPaper} />;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar
        title={paper.title ?? 'Brainstorm'}
        onNew={() => {
          void window.wb.paper.clear().then(() => setPaper(null));
        }}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <Whiteboard host={host} />
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
