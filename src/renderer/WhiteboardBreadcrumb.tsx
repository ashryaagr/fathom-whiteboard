/**
 * Breadcrumb at the top-left of the whiteboard canvas, e.g.:
 *
 *   Paper ▸ Encoder
 *
 * Each segment is clickable to jump back. System sans (chrome, not
 * voice — CLAUDE.md §2.4). Doherty rule: clicking a segment must
 * paint the focus change in ≤ 50 ms; we do that by setting the focus
 * state synchronously and letting Excalidraw scrollToContent handle
 * the camera animation.
 */

import { useWhiteboardStore } from './store';

interface Props {
  paperHash: string;
  paperTitle?: string;
}

export default function WhiteboardBreadcrumb({ paperHash, paperTitle }: Props) {
  const wb = useWhiteboardStore((s) => s.byPaper.get(paperHash));
  const setFocus = useWhiteboardStore((s) => s.setFocus);
  if (!wb) return null;
  const focus = wb.focus;
  const parentLabel =
    focus.kind === 'level2' && wb.level1
      ? wb.level1.nodes.find((n) => n.id === focus.parentNodeId)?.label
      : null;
  return (
    <div
      className="pointer-events-auto absolute top-3 left-4 z-20 flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-medium text-black/65 shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <button
        onClick={() => setFocus(paperHash, { kind: 'level1' })}
        className="rounded px-1 transition hover:bg-black/5"
        title="Back to Level 1 of this paper"
      >
        {paperTitle ? truncate(paperTitle, 32) : 'Paper'}
      </button>
      {focus.kind === 'level2' && (
        <>
          <span className="text-black/30">▸</span>
          <span className="px-1 text-black/85">
            {parentLabel ?? focus.parentNodeId}
          </span>
        </>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
