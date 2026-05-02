import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
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
  session: {
    archive: () => Promise<{ archivedAt: string | null }>;
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

// ---------- error boundary ----------
//
// Catches renderer-side React errors that would otherwise leave the
// window blank with the error only visible in DevTools. Shows the
// message + stack inline so the user can read what went wrong without
// opening DevTools.

type ErrorBoundaryState = { error: Error | null };

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfacing to the renderer console as well so DevTools history
    // captures the original throw site (React only reports the
    // boundary catch otherwise).
    // eslint-disable-next-line no-console
    console.error('[clawdSlate ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            background: '#fff',
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 720, width: '100%' }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: '#c00',
                marginBottom: 12,
              }}
            >
              clawdSlate hit a renderer error
            </div>
            <div
              style={{
                fontSize: 13,
                color: '#1d1d1f',
                marginBottom: 16,
                whiteSpace: 'pre-wrap',
                background: 'rgba(220,0,0,0.05)',
                border: '1px solid rgba(220,0,0,0.2)',
                padding: 12,
                borderRadius: 8,
                fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
              }}
            >
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
            </div>
            <button
              onClick={this.reset}
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                color: '#fff',
                background: '#0a84ff',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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

// ---------- settings (tool toggles) ----------
//
// Two toggles, persisted to localStorage so they survive reloads. Web
// search defaults on (historical behaviour); arxiv defaults off so a
// user who never opens settings doesn't pay the spawn cost or have an
// extra MCP described to the agent on every call.

type ToolSettings = { webSearch: boolean; arxiv: boolean };

// Storage key bumped to v2 when the default for `arxiv` flipped from
// false to true. New users start with both on; existing v1 users get
// the new default once (their old key is left in place but unused).
const SETTINGS_KEY = 'clawdSlate.toolSettings.v2';
const DEFAULT_TOOL_SETTINGS: ToolSettings = { webSearch: true, arxiv: true };

function loadToolSettings(): ToolSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_TOOL_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ToolSettings>;
    return {
      webSearch: typeof parsed.webSearch === 'boolean' ? parsed.webSearch : true,
      arxiv: typeof parsed.arxiv === 'boolean' ? parsed.arxiv : true,
    };
  } catch {
    return { ...DEFAULT_TOOL_SETTINGS };
  }
}

function saveToolSettings(s: ToolSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* localStorage full / disabled — ignore */
  }
}

export function App() {
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [paperLoaded, setPaperLoaded] = useState(false);
  const [resetCount, setResetCount] = useState(0);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toolSettings, setToolSettings] = useState<ToolSettings>(() =>
    loadToolSettings(),
  );

  // Stable mirror of `paper` so the host (built once) can read the
  // latest value without being reconstructed on every state change.
  // Reconstructing the host would re-run Whiteboard's loadScene effect
  // and cancel any in-flight generation.
  const paperRef = useRef<PaperPayload | null>(null);
  // Same mirror trick for tool settings — host closes over them once,
  // but we want toggle changes to apply on the next Send without
  // rebuilding the host (which would cancel in-flight runs).
  const toolSettingsRef = useRef<ToolSettings>(toolSettings);

  // Guards saveScene() during a clear/remount cycle. Without it, the
  // Whiteboard's unmount cleanup calls flushSaveScene(staleSceneRef)
  // which writes the just-discarded scene right back to disk — losing
  // the clear and re-loading the old whiteboard on remount.
  const isClearingRef = useRef(false);

  useEffect(() => {
    paperRef.current = paper;
  }, [paper]);

  useEffect(() => {
    toolSettingsRef.current = toolSettings;
    saveToolSettings(toolSettings);
  }, [toolSettings]);

  useEffect(() => {
    (async () => {
      const p = await window.wb.paper.load();
      if (p) {
        paperRef.current = p;
        setPaper(p);
        setPaperLoaded(true);
        return;
      }
      // No paper on disk. If a scene is also present, the previous
      // session ended in a corrupted half-cleared state (paper.json
      // emptied but whiteboard.excalidraw not). Make state consistent
      // by clearing the orphan scene so the new session starts blank.
      const orphanScene = await window.wb.scene.load();
      if (orphanScene && orphanScene.elements.length > 0) {
        console.log(
          `[clawdSlate] startup recovery — found orphan scene (${orphanScene.elements.length} elements) with no paper; clearing`,
        );
        await window.wb.scene.save({ elements: [] });
      }
      setPaperLoaded(true);
    })();
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
        // Skip writes during a clear cycle — the Whiteboard's unmount
        // cleanup tries to flush its sceneRef and would otherwise undo
        // the explicit empty-scene write done in clear() below.
        if (isClearingRef.current) {
          console.log(`[clawdSlate] saveScene SKIPPED (clearing) — would have written ${s.elements.length} elements`);
          return;
        }
        console.log(`[clawdSlate] saveScene → ${s.elements.length} elements`);
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
              { paper: activePaper, focus: activeFocus, tools: toolSettingsRef.current },
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
          let activePaper = paperRef.current;
          if (!activePaper) {
            // Refine reached without an established paper — usually a
            // corrupted-disk-state recovery path. Synthesize from the
            // instruction (same as generate's first-Send) and persist
            // so subsequent refines stay grounded.
            console.log('[clawdSlate] refine — no paper, synthesizing from instruction');
            activePaper = synthesizePaper(instruction);
            paperRef.current = activePaper;
            setPaper(activePaper);
            void window.wb.paper.save(activePaper);
          }
          void window.wb
            .refine(
              {
                paper: activePaper,
                scene: { elements: scene.elements },
                instruction,
                tools: toolSettingsRef.current,
              },
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
        console.log('[clawdSlate] clear START — isClearingRef = true');
        isClearingRef.current = true;
        try {
          await window.wb.paper.clear();
          console.log('[clawdSlate] clear → paper.clear done');
          await window.wb.scene.save({ elements: [] });
          console.log('[clawdSlate] clear → wrote empty scene to disk');
          paperRef.current = null;
          setPaper(null);
          setResetCount((n) => {
            console.log(`[clawdSlate] clear → resetCount ${n} → ${n + 1}`);
            return n + 1;
          });
        } finally {
          setTimeout(() => {
            console.log('[clawdSlate] clear → guard released');
            isClearingRef.current = false;
          }, 500);
        }
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
        title={paper?.title ?? 'clawdSlate'}
        onNew={() => {
          // No paper yet → already a fresh canvas, nothing to confirm.
          if (!paper) return;
          setShowNewModal(true);
        }}
        onSettings={() => setShowSettings((s) => !s)}
      />
      {showSettings && (
        <SettingsPopover
          settings={toolSettings}
          onChange={setToolSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ErrorBoundary>
          <Whiteboard host={host} key={resetCount} />
        </ErrorBoundary>
      </div>
      {showNewModal && (
        <NewWhiteboardModal
          onCancel={() => setShowNewModal(false)}
          onSaveAndNew={async () => {
            setShowNewModal(false);
            await window.wb.session.archive();
            await host.clear?.();
          }}
          onDiscardAndNew={async () => {
            setShowNewModal(false);
            await host.clear?.();
          }}
        />
      )}
    </div>
  );
}

// Modal shown when the user clicks "New" with an existing whiteboard
// on the canvas. Two destructive paths so the user has to opt in:
//   - Save & New: snapshot the current scene+paper into an archive
//     dir under `sessions/archive-<ts>/`, then start fresh.
//   - Discard & New: throw away the current whiteboard, start fresh.
// Cancel returns to the existing canvas without changing anything.
function NewWhiteboardModal({
  onCancel,
  onSaveAndNew,
  onDiscardAndNew,
}: {
  onCancel: () => void;
  onSaveAndNew: () => void;
  onDiscardAndNew: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-modal-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '90%',
          padding: 22,
          background: '#fff',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        }}
      >
        <div
          id="new-modal-title"
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: '#1d1d1f',
            marginBottom: 6,
          }}
        >
          Start a new whiteboard?
        </div>
        <div
          style={{
            fontSize: 13,
            color: '#3a3a3c',
            lineHeight: 1.5,
            marginBottom: 18,
          }}
        >
          Your current whiteboard will be replaced with an empty canvas.
          Save it first to keep an archived copy, or discard it.
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: '#1d1d1f',
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onDiscardAndNew}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: '#c00',
              background: 'rgba(220,0,0,0.06)',
              border: '1px solid rgba(220,0,0,0.22)',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Discard
          </button>
          <button
            onClick={onSaveAndNew}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: '#fff',
              background: '#0a84ff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Save & start new
          </button>
        </div>
      </div>
    </div>
  );
}

function TopBar({
  title,
  onNew,
  onSettings,
}: {
  title: string;
  onNew: () => void;
  onSettings: () => void;
}) {
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          WebkitAppRegion: 'no-drag' as never,
        }}
      >
        <button
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            color: '#86868b',
            background: 'transparent',
            border: 'none',
            borderRadius: 7,
            cursor: 'pointer',
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          onClick={onNew}
          style={{
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
    </div>
  );
}

// Lightweight popover anchored under the gear icon. Click-outside or
// Esc closes. Two toggles only — keep this surface minimal per the
// product's "simple, minimal options" rule.
function SettingsPopover({
  settings,
  onChange,
  onClose,
}: {
  settings: ToolSettings;
  onChange: (s: ToolSettings) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 90,
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          position: 'absolute',
          top: 48,
          right: 14,
          width: 280,
          padding: 14,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          border: '1px solid rgba(0,0,0,0.06)',
          zIndex: 91,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#86868b',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            marginBottom: 8,
          }}
        >
          Tools the agent can use
        </div>
        <ToggleRow
          label="Web search"
          hint="Look up cited prior work or unfamiliar terms online."
          checked={settings.webSearch}
          onChange={(v) => onChange({ ...settings, webSearch: v })}
        />
        <ToggleRow
          label="arXiv"
          hint="Fetch papers from arxiv.org by id or query."
          checked={settings.arxiv}
          onChange={(v) => onChange({ ...settings, arxiv: v })}
        />
      </div>
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 10,
        padding: '8px 0',
        cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#1d1d1f' }}>
          {label}
        </div>
        <div style={{ fontSize: 11, color: '#86868b', marginTop: 2 }}>{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, cursor: 'pointer' }}
      />
    </label>
  );
}
