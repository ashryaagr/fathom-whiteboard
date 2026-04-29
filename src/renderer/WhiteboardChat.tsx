/**
 * Whiteboard chat — the unified right rail. Replaces the old split
 * between WhiteboardStreamingSidebar (read-only token stream during
 * pass1/pass2) and WhiteboardSideChat (interactive chat once ready).
 *
 * One component, one mount point, one position. Status-driven body:
 *   - pass1: stream wb.understanding, Ask DISABLED
 *   - pass2: stream wb.pass2Stream,   Ask DISABLED
 *   - ready / expanding / error: existing chat-thread history + Ask
 *
 * Always mounted whenever wb exists and status !== 'consent'. Toggle
 * via the same `‹/›` chevron + `chatCollapsed` zustand slot +
 * `whiteboardSideChatCollapsed` settings persistence as before.
 *
 * Hick's Law cap = 4 controls (per spec):
 *   1. Body (scrollable: streaming tokens during gen, chat history once ready)
 *   2. Ask box (sticky bottom; disabled during pass1/pass2)
 *   3. Apply-to-canvas affordance — only present when the AI's last
 *      assistant turn modified the scene
 *   4. Collapse arrow at the top
 *
 * NO model picker, NO temperature slider, NO export, NO clear-thread.
 *
 * Spec: .claude/specs/whiteboard-diagrams.md (the "Side chat" section).
 * Unification: #62 / #63 (2026-04-29).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWhiteboardHost } from './host';
import {
  frameIdFor,
  useWhiteboardStore,
  type WBChatTurn,
  type WBFrameId,
  type WBPipelineStatus,
} from './store';

interface Props {
  paperHash: string;
  /** Called when the AI returned a new scene — the WhiteboardTab
   * applies it to the live Excalidraw canvas. With chat-as-diagram
   * (2026-04-26) the third arg is the chatQueryId so the WhiteboardTab
   * can dedupe + route into chatScenes (not L1/L2). */
  onSceneModified?: (sceneJson: string, frameId: WBFrameId, chatQueryId?: string) => void;
  /** Called when the user clicks "Jump to chart" on an assistant turn.
   * Receives the Excalidraw element id of the chat-frame; the parent
   * tab resolves to the live element + scrollToContent's the canvas. */
  onJumpToFrame?: (frameElementId: string) => void;
}

const RAIL_WIDTH_PX = 320;
const COLLAPSED_WIDTH_PX = 32;

export default function WhiteboardChat({ paperHash, onSceneModified, onJumpToFrame }: Props) {
  const host = useWhiteboardHost();
  const wb = useWhiteboardStore((s) => s.byPaper.get(paperHash));
  // Narrow selector-bound setters — see #59 §6 lesson. Subscribing to
  // the entire store (`useWhiteboardStore()` with no selector) returns
  // a fresh reference on every state update, which destabilises any
  // useEffect/useCallback that lists `store` as a dep — re-running the
  // hydration in a loop under StrictMode. Each setter below is a
  // stable function reference pinned by zustand's selector cache.
  const setChatThreads = useWhiteboardStore((s) => s.setChatThreads);
  const setChatCollapsed = useWhiteboardStore((s) => s.setChatCollapsed);
  const setChatInFlight = useWhiteboardStore((s) => s.setChatInFlight);
  const appendChatTurn = useWhiteboardStore((s) => s.appendChatTurn);
  const appendStreamingChatDelta = useWhiteboardStore((s) => s.appendStreamingChatDelta);
  const finishStreamingChatTurn = useWhiteboardStore((s) => s.finishStreamingChatTurn);

  const collapsed = wb?.chatCollapsed ?? false;
  const inFlight = wb?.chatInFlight ?? false;
  const focus = wb?.focus ?? { kind: 'level1' as const };
  const frameId: WBFrameId = useMemo(() => frameIdFor(focus), [focus]);
  const thread = wb?.chatThreads.get(frameId) ?? [];
  const parentNodeId = focus.kind === 'level2' ? focus.parentNodeId : undefined;
  const status = wb?.status;
  const streamingPhase = status === 'pass1' || status === 'pass2';

  // -----------------------------------------------------------------
  // Initial load: hydrate threads from disk on first mount per paper.
  // Also load the persisted collapsed preference from settings.
  //
  // Same `[hydrating, setHydrating]` shape as WhiteboardTab.tsx (#59).
  // The previous useRef-based guard (`hydratedRef.current === paperHash`)
  // deadlocked under React 18 Strict Mode: pass-1 effect set the ref +
  // started fetch, cleanup set cancelled=true, pass-2 effect found the
  // ref already matching paperHash and early-returned, and pass-1's
  // `finally` was gated on `!cancelled` so the hydrated map never
  // landed. Fix: drop the ref entirely, always flip `hydrating` in
  // finally; both `whiteboardChatLoad` (readFile only) and
  // `getSettings` are idempotent so doubling them under Strict Mode is
  // harmless. State value is `true` initially so the first paint
  // reflects "we're loading, don't trust an empty thread map yet."
  // -----------------------------------------------------------------
  const [hydrating, setHydrating] = useState(true);
  useEffect(() => {
    setHydrating(true);
    let cancelled = false;
    void (async () => {
      try {
        const [chatLoadResult, settings] = await Promise.all([
          host.chatLoad(paperHash),
          host.getSettings(),
        ]);
        if (cancelled) return;
        const map = new Map<WBFrameId, WBChatTurn[]>();
        for (const [k, v] of Object.entries(chatLoadResult.threads)) {
          map.set(k as WBFrameId, v as WBChatTurn[]);
        }
        setChatThreads(paperHash, map);
        if (typeof settings.whiteboardSideChatCollapsed === 'boolean') {
          setChatCollapsed(paperHash, settings.whiteboardSideChatCollapsed);
        }
      } catch (err) {
        console.warn('[WhiteboardChat] hydrate failed', err);
      } finally {
        // Always flip — even if this effect's body got cancelled, the
        // sibling Strict Mode effect-pass is racing the same idempotent
        // IPC and will succeed. The hydrating flag must reflect "we
        // know what's on disk" regardless of which pass got there first.
        setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Selector-bound setters from zustand are stable refs; deps kept
    // to `[paperHash]` to avoid re-running the hydration when other
    // store slices update. eslint-disable suppresses exhaustive-deps'
    // false-positive on the stable setter refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperHash]);

  // -----------------------------------------------------------------
  // Auto-scroll: bottom on new chat turn / streaming delta / streaming-
  // phase token append. Same handler covers both bodies because they
  // share one scroller.
  // -----------------------------------------------------------------
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const streamLen = streamingPhase
    ? (status === 'pass1' ? wb?.understanding?.length : wb?.pass2Stream?.length) ?? 0
    : 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thread.length, thread[thread.length - 1]?.text.length, frameId, streamLen, status]);

  const toggleCollapse = useCallback(() => {
    const next = !collapsed;
    setChatCollapsed(paperHash, next);
    // Persist for cross-session stickiness.
    void host.updateSettings({ whiteboardSideChatCollapsed: next });
  }, [collapsed, paperHash, setChatCollapsed]);

  // -----------------------------------------------------------------
  // Send handler. Fires the IPC, streams deltas into the assistant
  // turn we appended optimistically, and applies any scene the AI
  // returned to the canvas via onSceneModified.
  // -----------------------------------------------------------------
  const inFlightHandleRef = useRef<{ abort: () => void } | null>(null);
  const send = useCallback(
    async (userText: string) => {
      const text = userText.trim();
      if (!text) return;
      if (inFlight) return;
      const currentSceneJson = collectFrameSceneJson(paperHash, frameId);
      const userTurn: WBChatTurn = { role: 'user', text, ts: Date.now() };
      const assistantTurn: WBChatTurn = {
        role: 'assistant',
        text: '',
        ts: Date.now(),
        streaming: true,
      };
      appendChatTurn(paperHash, frameId, userTurn);
      appendChatTurn(paperHash, frameId, assistantTurn);
      setChatInFlight(paperHash, true);
      try {
        const handle = await host.chatSend(
          {
            paperHash,
            frameId,
            userText: text,
            currentSceneJson,
            parentNodeId,
          },
          {
            onDelta: (delta) => {
              appendStreamingChatDelta(paperHash, frameId, delta);
            },
            onDone: (info) => {
              finishStreamingChatTurn(paperHash, frameId, {
                sceneModified: info.sceneModified,
                chatFrameId: info.chatFrameId ?? undefined,
                chatQueryId: info.chatQueryId ?? undefined,
              });
              if (info.sceneModified && info.modifiedScene) {
                onSceneModified?.(
                  info.modifiedScene,
                  frameId,
                  info.chatQueryId ?? undefined,
                );
              }
              setChatInFlight(paperHash, false);
              inFlightHandleRef.current = null;
            },
            onError: (message) => {
              finishStreamingChatTurn(paperHash, frameId, { error: message });
              setChatInFlight(paperHash, false);
              inFlightHandleRef.current = null;
            },
          },
        );
        inFlightHandleRef.current = handle;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finishStreamingChatTurn(paperHash, frameId, { error: message });
        setChatInFlight(paperHash, false);
        inFlightHandleRef.current = null;
      }
    },
    [
      appendChatTurn,
      appendStreamingChatDelta,
      finishStreamingChatTurn,
      frameId,
      inFlight,
      onSceneModified,
      paperHash,
      parentNodeId,
      setChatInFlight,
    ],
  );

  // Abort the in-flight chat call when the user switches paper / frame
  // / leaves the tab, so a stale stream can't write into the wrong
  // thread.
  useEffect(() => {
    return () => {
      inFlightHandleRef.current?.abort();
      inFlightHandleRef.current = null;
    };
  }, [paperHash]);

  if (collapsed) {
    return (
      <div
        className="flex h-full flex-col items-center border-l border-black/8 bg-white/85 backdrop-blur"
        style={{ width: COLLAPSED_WIDTH_PX, fontFamily: 'system-ui, -apple-system, sans-serif' }}
      >
        <button
          onClick={toggleCollapse}
          className="mt-3 flex h-7 w-7 items-center justify-center rounded text-black/55 transition hover:bg-black/5 hover:text-black/85"
          title="Open whiteboard chat"
          aria-label="Open whiteboard chat"
        >
          <ChevronLeft />
        </button>
        <div
          className="mt-3 -rotate-90 text-[10px] tracking-widest text-black/45 select-none uppercase"
          style={{ writingMode: 'horizontal-tb' }}
        >
          chat
        </div>
        {streamingPhase && (
          <span
            aria-hidden
            className="mt-3 inline-block h-2 w-2 animate-pulse rounded-full bg-[#9f661b]"
            title={status === 'pass1' ? 'Reading the paper…' : 'Drawing the diagram…'}
          />
        )}
      </div>
    );
  }

  const placeholder = streamingPhase
    ? 'Available once the whiteboard is ready.'
    : focus.kind === 'level1'
      ? 'Ask about this whiteboard…'
      : 'Ask about this part…';

  return (
    <div
      className="flex h-full flex-col border-l border-black/8 bg-white/85 backdrop-blur"
      style={{ width: RAIL_WIDTH_PX, fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <Header onCollapse={toggleCollapse} frameId={frameId} status={status} />
      {!streamingPhase && <StatusStrip paperHash={paperHash} />}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-4 py-3"
      >
        {streamingPhase ? (
          <StreamingBody
            text={(status === 'pass1' ? wb?.understanding : wb?.pass2Stream) ?? ''}
          />
        ) : hydrating ? (
          // Hold the EmptyState until the disk-load resolves — avoids
          // a 50-100 ms flash of "Ask about the paper as a whole" right
          // before a persisted thread paints. Empty fragment so the
          // scroller keeps its layout but renders nothing.
          <></>
        ) : thread.length === 0 ? (
          <EmptyState frameKind={focus.kind} />
        ) : (
          <div className="flex flex-col gap-4">
            {thread.map((t, i) => (
              <ChatTurnBlock
                turn={t}
                onJumpToFrame={onJumpToFrame}
                key={`${frameId}:${i}:${t.ts}`}
              />
            ))}
          </div>
        )}
      </div>
      <AskBox
        onSend={send}
        disabled={inFlight || streamingPhase}
        placeholder={placeholder}
      />
    </div>
  );
}

// -----------------------------------------------------------------
// StreamingBody — Pass 1 / Pass 2 read-only token stream rendered
// inside the same scroller the chat history will use once ready.
// Plain text, system sans, leading-relaxed; the warming-up cue
// matches the lens "▾ working" surface so the user reads it as
// "Claude is thinking" not "the app froze".
// -----------------------------------------------------------------
function StreamingBody({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-black/70">
      {text || <span className="text-black/35">Warming up…</span>}
    </div>
  );
}

// -----------------------------------------------------------------
// StatusStrip — Round 14d. Surfaces the most recent yield_step
// summary from the step-loop as a single thin CLI-style line below
// the chat header. Visible while a step-loop is active; on `done:
// true`, shows "✓ ready" briefly then fades out after 2 s. The
// `lastStep` store slot is updated by the `whiteboard:step` IPC
// subscriber in WhiteboardTab.tsx (round-14b plumbing).
//
// Visual: subtle gray, system-mono, single line, 200 ms fade
// transition on summary changes. Truncated to 60 chars (per
// dispatch — typical step summaries like "comparison-matrix: 4
// methods × 3 metrics" fit comfortably). No border, no chrome.
// -----------------------------------------------------------------
function StatusStrip({ paperHash }: { paperHash: string }) {
  const lastStep = useWhiteboardStore((s) => s.byPaper.get(paperHash)?.lastStep ?? null);
  const [visible, setVisible] = useState(false);
  const [renderedText, setRenderedText] = useState<string | null>(null);

  useEffect(() => {
    if (!lastStep) {
      setVisible(false);
      return;
    }
    if (lastStep.done) {
      // Show the success ping briefly, then fade out.
      setRenderedText('✓ ready');
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    }
    // Active step — show truncated summary.
    const truncated = lastStep.summary.length > 60
      ? lastStep.summary.slice(0, 59) + '…'
      : lastStep.summary;
    setRenderedText(truncated);
    setVisible(true);
  }, [lastStep]);

  if (!renderedText) return null;
  return (
    <div
      className="flex h-6 items-center overflow-hidden border-b border-black/[0.04] px-4 text-[10.5px] tracking-tight text-black/45 transition-opacity duration-200"
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        opacity: visible ? 1 : 0,
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="truncate">{renderedText}</span>
    </div>
  );
}

// -----------------------------------------------------------------
// Header — collapse arrow + label. Uses sans (chrome, not voice).
// During pass1/pass2 the label tracks the active phase; otherwise
// it falls back to the frame label.
// -----------------------------------------------------------------
function Header({
  onCollapse,
  frameId,
  status,
}: {
  onCollapse: () => void;
  frameId: WBFrameId;
  status: WBPipelineStatus | undefined;
}) {
  let label: string;
  if (status === 'pass1') label = 'Reading the paper · Opus 4.7';
  else if (status === 'pass2') label = 'Drawing the diagram · Opus 4.7';
  else label = frameId === 'level1' ? 'Level 1 chat' : 'Detail chat';
  const streamingPhase = status === 'pass1' || status === 'pass2';
  return (
    <div className="flex items-center justify-between border-b border-black/6 px-4 py-2.5 text-[11px] font-medium tracking-wide text-black/55 uppercase">
      <span className="flex items-center gap-2">
        {streamingPhase && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#9f661b]"
          />
        )}
        <span>{label}</span>
      </span>
      <button
        onClick={onCollapse}
        className="flex h-6 w-6 items-center justify-center rounded text-black/45 transition hover:bg-black/5 hover:text-black/85"
        title="Collapse chat"
        aria-label="Collapse chat"
      >
        <ChevronRight />
      </button>
    </div>
  );
}

// -----------------------------------------------------------------
// Empty state — explains what the chat is for, keeps the rail useful
// even before the user types. Mirrors the lens "ask anything" cue.
// -----------------------------------------------------------------
function EmptyState({ frameKind }: { frameKind: 'level1' | 'level2' }) {
  const tip = frameKind === 'level1'
    ? 'Ask about the paper as a whole, or how a part fits in.'
    : 'Ask about this section — or request a tweak to its diagram.';
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p
        className="m-0 text-[14px] leading-snug text-black/55"
        style={{ fontFamily: 'var(--font-handwritten)' }}
      >
        {tip}
      </p>
      <p className="mt-3 text-[11px] text-black/35">
        Tip: ask "make X bigger" or "add citation" to edit the diagram.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------
// One chat turn — user question (Excalifont, soft border-left) or
// assistant reply (Excalifont prose, sans metadata, 'applied' chip
// when it modified the scene).
// -----------------------------------------------------------------
function ChatTurnBlock({
  turn,
  onJumpToFrame,
}: {
  turn: WBChatTurn;
  onJumpToFrame?: (frameElementId: string) => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="border-l-[3px] border-[#9f661b]/45 pl-3 py-0.5">
        <p
          className="m-0 leading-snug text-black/80"
          style={{
            fontFamily: 'var(--font-handwritten)',
            fontSize: '14px',
            letterSpacing: '0.005em',
          }}
        >
          {turn.text}
        </p>
      </div>
    );
  }
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[10px] tracking-wide text-[#9f661b] uppercase select-none">
        <span className="h-px w-5 bg-[#9f661b]/40" />
        <span>reply</span>
        {turn.streaming && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#9f661b]"
          />
        )}
        {turn.sceneModified && !turn.streaming && (
          <span className="rounded bg-[#fef4d8] px-1.5 py-px text-[9px] font-medium text-[#9f661b] tracking-normal normal-case">
            applied to canvas
          </span>
        )}
        <span className="h-px flex-1 bg-[#9f661b]/15" />
      </div>
      {turn.error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {turn.error}
        </div>
      ) : turn.text.length > 0 ? (
        <p
          className="m-0 whitespace-pre-wrap text-[13px] leading-[1.55] text-black/85"
          style={{ fontFamily: 'var(--font-handwritten)' }}
        >
          {turn.text}
        </p>
      ) : turn.streaming ? (
        <ThinkingDots />
      ) : null}
      {turn.chatFrameId && !turn.streaming && onJumpToFrame && (
        <button
          type="button"
          onClick={() => onJumpToFrame(turn.chatFrameId!)}
          className="mt-1 self-start rounded bg-[#fef4d8] px-2 py-0.5 text-[11px] font-medium text-[#9f661b] transition hover:bg-[#fae3a8]"
          title="Scroll the canvas to the chart this reply added"
          aria-label="Jump to the new chart on the canvas"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
          Jump to chart &rarr;
        </button>
      )}
    </section>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1 pl-1" aria-label="Thinking…">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9f661b]/65" style={{ animationDelay: '0ms' }} />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9f661b]/65" style={{ animationDelay: '180ms' }} />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9f661b]/65" style={{ animationDelay: '360ms' }} />
    </div>
  );
}

// -----------------------------------------------------------------
// Ask box — sticky bottom textarea. Enter sends; Shift+Enter inserts
// a newline. Auto-resizes up to 6 lines. The send button sits outside
// the textarea on the right (matches the lens Ask footer pattern).
// -----------------------------------------------------------------
function AskBox({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void | Promise<void>;
  disabled: boolean;
  placeholder: string;
}) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize on change (cap at ~6 lines so the box never eats the
  // whole rail).
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
  }, []);
  useEffect(() => resize(), [value, resize]);

  const submit = useCallback(() => {
    if (disabled) return;
    const text = value.trim();
    if (!text) return;
    void onSend(text);
    setValue('');
    // Reset height after clearing.
    requestAnimationFrame(() => resize());
  }, [disabled, onSend, resize, value]);

  return (
    <div className="border-t border-black/6 px-3 py-2.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          aria-label="Ask the whiteboard chat"
          disabled={disabled}
          className="flex-1 resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-[13px] leading-snug text-black/85 placeholder:text-black/35 focus:border-[#9f661b]/55 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            fontFamily: 'system-ui, -apple-system, sans-serif',
            maxHeight: '130px',
          }}
        />
        <button
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#9f661b] text-white transition hover:bg-[#86541a] disabled:cursor-not-allowed disabled:opacity-40"
          title={disabled ? 'Waiting for reply…' : 'Send (Enter)'}
          aria-label="Send message"
        >
          <SendArrow />
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/** Pull the JSON for the current frame out of the store. The store
 * Chat-as-diagram (2026-04-26): the chat agent reads the FULL canvas
 * (L1 + every L2 + every prior chat frame) via `read_diagram_state`
 * so it can park its new chat frame to the right of everything and
 * reference existing nodes by name. So we always return the full
 * persisted scene (`excalidrawScene`) when available; pass2L1/L2 are
 * the in-session deltas which the persisted scene has already
 * incorporated by this point. Returns "{}" only as a last resort. */
function collectFrameSceneJson(paperHash: string, frameId: WBFrameId): string {
  const wb = useWhiteboardStore.getState().byPaper.get(paperHash);
  if (!wb) return '{}';
  // Prefer the persisted full scene — it's the union of L1 + every L2 +
  // every prior chat frame, so the chat agent's read_diagram_state
  // sees the complete canvas.
  if (wb.excalidrawScene) return wb.excalidrawScene;
  if (frameId === 'level1') return wb.pass2L1Scene ?? '{}';
  const parentId = frameId.slice('level2:'.length);
  return wb.pass2L2Scenes.get(parentId) ?? '{}';
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SendArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}
