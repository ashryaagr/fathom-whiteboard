/**
 * Inline consent affordance shown the first time a user clicks the
 * Whiteboard tab on a paper that has no whiteboard yet.
 *
 * Per the cog reviewer §8 ruling, this is an *inline button*, not a
 * modal. The user clicked the tab; the consent surface lives inside
 * the tab they already opened. No extra navigation cost.
 *
 * Three pieces of information the user needs (Johnson & Goldstein 2003 —
 * informed consent, financial implications):
 *   - what the action does (generate a whiteboard for THIS paper)
 *   - what it costs (~$1.50, billed to your Claude CLI auth)
 *   - how long it takes (~60s)
 *
 * No fine print, no scary warnings, no nested cards. Just one button
 * with a calm copy line and a "remember this" toggle the user can
 * flip if they want auto-generation on every paper from here on.
 */

import { useState } from 'react';

interface Props {
  onAccept: (rememberChoice: boolean) => void;
  onCancel: () => void;
}

export default function WhiteboardConsent({ onAccept, onCancel }: Props) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="flex h-full w-full items-center justify-center bg-[color:var(--color-paper)] px-8">
      <div
        className="relative w-[min(540px,92vw)] overflow-hidden rounded-[18px] p-8 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),0_18px_48px_rgba(201,131,42,0.12)]"
        style={{ background: '#faf4e8', outline: '1px solid rgba(224, 211, 172, 0.6)' }}
      >
        <div
          className="mb-3 text-[24px] leading-tight"
          style={{
            fontFamily: "'Excalifont', 'Caveat', 'Kalam', 'Bradley Hand', cursive",
            color: '#1a1614',
          }}
        >
          Generate the whiteboard for this paper?
        </div>
        <p className="mx-auto mb-6 max-w-[420px] text-[13px] leading-relaxed text-black/65">
          Fathom will read the entire paper end-to-end and draw a
          hand-sketched diagram of its core methodology. Click any
          piece of the diagram to zoom into a more detailed sub-diagram.
        </p>
        <div className="mb-6 flex items-center justify-center gap-5 text-[12px] text-black/60">
          <span className="flex items-center gap-1.5">
            <span className="text-[14px] tabular-nums" style={{ color: '#9f661b' }}>
              ~$3
            </span>
            <span className="text-black/45">one-time, your Claude CLI</span>
          </span>
          <span className="text-black/25">·</span>
          <span className="flex items-center gap-1.5">
            <span className="text-[14px] tabular-nums" style={{ color: '#9f661b' }}>
              ~2 min
            </span>
            <span className="text-black/45">to first paint</span>
          </span>
        </div>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={onCancel}
            className="rounded-full px-4 py-2 text-[13px] font-medium text-black/55 transition hover:bg-black/[0.04]"
          >
            Not now
          </button>
          <button
            onClick={() => onAccept(remember)}
            className="rounded-full bg-[#1a1614] px-5 py-2 text-[13px] font-medium text-[#faf4e8] transition hover:bg-[#3a2c20] active:scale-[0.98]"
          >
            Generate whiteboard
          </button>
        </div>
        <label className="mt-5 flex cursor-pointer items-center justify-center gap-2 text-[11.5px] text-black/45 select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-black/30 text-[#9f661b] focus:ring-1 focus:ring-[#9f661b]"
          />
          Auto-generate for new papers I open
        </label>
      </div>
    </div>
  );
}
