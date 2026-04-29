/**
 * Top-right whiteboard controls: Regenerate + Clear. System sans
 * (chrome — CLAUDE.md §2.4). Two actions because they're different
 * intents — Regenerate replaces the current scene with a fresh one
 * ($4 spend), Clear nukes everything back to the consent surface
 * ($0, but you have to consent + wait again next time).
 *
 * Doherty: both buttons disable + relabel synchronously on click.
 *
 * Confirm before Clear: the user is throwing away ~$4 of generation
 * cost they already paid for. Browser confirm() is fine — the surface
 * is rare (no one clicks Clear casually) and the dialog reads in <1s.
 *
 * Regenerate opens a small inline popover where the user can type
 * guidance ("focus on the loss function", "show only the encoder",
 * "skip the math sections"). The string is forwarded through
 * `onRegenerate(guidance)` and threaded into `purposeAnchor` on the
 * IPC, where it lands in `<reader_purpose>` for both Pass 1 and Pass 2.
 * Empty guidance is a plain regenerate (same as the prior behaviour).
 */

import { useEffect, useRef, useState } from 'react';
import { useWhiteboardHost } from './host';
import { useWhiteboardStore } from './store';

interface Props {
  paperHash: string;
  onRegenerate: (guidance: string | null) => void;
}

const EXAMPLES: string[] = [
  'Focus on the training loss',
  'Show only the encoder pipeline',
  'Skip the math; emphasize the architecture',
  'Highlight what is novel vs prior work',
];

export default function WhiteboardRegenerateButton({ paperHash, onRegenerate }: Props) {
  const host = useWhiteboardHost();
  const status = useWhiteboardStore((s) => s.byPaper.get(paperHash)?.status);
  const reset = useWhiteboardStore((s) => s.reset);
  // Chat-rail clearance: rail is 320px open / 32px collapsed (per
  // WhiteboardSideChat.tsx). Add 16px gap so this button doesn't kiss
  // the rail's left edge. Read from the store so we slide left/right
  // with the rail's collapse state.
  const chatCollapsed = useWhiteboardStore(
    (s) => s.byPaper.get(paperHash)?.chatCollapsed ?? false,
  );
  const rightOffsetPx = chatCollapsed ? 32 + 16 : 320 + 16;
  const inFlight =
    status === 'pass1' || status === 'pass2' || status === 'expanding' || status === 'consent';

  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus the textarea the moment the popover opens — saves the
  // user a click and signals intent (the input is the primary action).
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => textareaRef.current?.focus(), 16);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Click-outside dismissal. Plain pointerdown listener at the document
  // level — the popover is small and short-lived; this is cheaper than
  // pulling in @radix-ui/react-popover for one surface.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Esc to dismiss; ⌘+Enter to submit. Standard chat-input shortcuts.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const trimmed = guidance.trim();
    setOpen(false);
    onRegenerate(trimmed.length > 0 ? trimmed : null);
    // Keep the typed guidance in state so the user can reopen + tweak
    // for a follow-up regenerate without re-typing the whole thing.
  }

  async function onClear() {
    const ok = window.confirm(
      'Delete this paper’s whiteboard?\n\n' +
        'You’ll need to re-consent and re-generate (~$3, ~2 min) the next time you open this tab.',
    );
    if (!ok) return;
    try {
      const res = await host.clear(paperHash);
      if (!res.ok) {
        console.warn('[Whiteboard UI] clear failed', res.error);
        return;
      }
      reset(paperHash);
    } catch (err) {
      console.warn('[Whiteboard UI] clear errored', err);
    }
  }

  return (
    <div
      className="pointer-events-auto absolute top-3 z-20 flex items-start gap-2"
      style={{
        right: `${rightOffsetPx}px`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <button
        type="button"
        onClick={onClear}
        disabled={inFlight}
        title="Delete this paper&rsquo;s whiteboard (returns to consent screen)"
        aria-label="Clear whiteboard"
        className="rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-medium text-black/55 shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur transition hover:bg-white hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white/80 disabled:hover:text-black/55"
      >
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true">×</span>
          Clear
        </span>
      </button>

      <div ref={popoverRef} className="relative flex flex-col items-end">
        <button
          type="button"
          onClick={() => {
            if (inFlight) return;
            setOpen((v) => !v);
          }}
          disabled={inFlight}
          title="Regenerate the whiteboard (optionally with custom guidance, ~$3)"
          aria-label="Regenerate whiteboard"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-medium text-black/70 shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur transition hover:bg-white hover:text-black/90 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white/80 disabled:hover:text-black/70"
        >
          {inFlight ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-black/15 border-t-[#9f661b]" />
              Generating&hellip;
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true">↻</span>
              Regenerate
            </span>
          )}
        </button>

        {open && !inFlight && (
          <div
            role="dialog"
            aria-label="Regenerate whiteboard with custom guidance"
            className="mt-2 w-[340px] rounded-xl border border-black/10 bg-white/95 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur"
          >
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-black/45">
              Optional guidance for Claude
            </div>
            <textarea
              ref={textareaRef}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="e.g. focus on the loss function, skip the related-work section, emphasize the encoder…"
              rows={3}
              className="w-full resize-none rounded-md border border-black/10 bg-white px-2.5 py-2 text-[12.5px] leading-snug text-black/85 outline-none ring-0 focus:border-[#9f661b]/50 focus:ring-2 focus:ring-[#9f661b]/15"
              style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setGuidance(ex)}
                  className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[10.5px] text-black/55 transition hover:bg-black/[0.08] hover:text-black/80"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-black/40">
                {guidance.trim().length > 0 ? '⌘↵ to regenerate' : 'Leave blank for a plain regenerate'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2.5 py-1 text-[11.5px] font-medium text-black/55 transition hover:bg-black/[0.04] hover:text-black/80"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  className="rounded-md bg-[#9f661b] px-2.5 py-1 text-[11.5px] font-medium text-white shadow-sm transition hover:bg-[#8a571a]"
                >
                  Regenerate
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
