/**
 * Templates module — shared types.
 *
 * Per excalidraw-expert's round-13 architecture: templates are MCP tool
 * wrappers that own their geometry by construction. Each template's
 * layout function takes (args, sectionWidth) and returns scene elements
 * in LAYOUT-LOCAL coordinates (origin at 0,0). The MCP
 * `instantiate_template` handler translates them to scene-absolute by
 * offsetting by the active section's (x + pad, content_y_start).
 *
 * Templates DO NOT call into scene state directly — they're pure
 * functions of (args, sectionWidth). This keeps them deterministic and
 * unit-testable in isolation (per CLAUDE.md §0 isolation principle), and
 * lets the MCP layer own the bbox/section-fit checks before the
 * elements ever get pushed.
 */

import type { SceneElement } from '../whiteboard-mcp';

export type { SceneElement };

export interface BBox {
  width: number;
  height: number;
}

/** Result of a template's layout function. Coordinates are LAYOUT-LOCAL
 * (origin at 0,0). The MCP wrapper translates them to scene-absolute
 * before pushing. `bbox` is the template's outer extent (used by the
 * wrapper for section-fit checks before any element is emitted). */
export interface TemplateResult {
  elements: SceneElement[];
  bbox: BBox;
  /** Optional warnings the wrapper relays back to the agent (e.g.
   * "comparison-matrix had 7 columns; clamped to 5 for fit"). */
  warnings?: string[];
}

/** A template definition. Pure: layout(args, sectionWidth) is
 * deterministic; same inputs always produce the same elements. */
export interface TemplateDef<Args = unknown> {
  /** Stable id matching `template-catalog.json`. */
  id: string;
  /** Human-readable name (also from the catalog). */
  name: string;
  /** Validate + cast a raw `args` value coming through MCP. Returns the
   * typed args or throws Error with a precise message the wrapper can
   * surface back to the agent. We do shape-checking by hand (Zod is
   * overkill for 4 templates with simple shapes); the wrapper tier
   * lifts errors into MCP-tool error responses. */
  validate(args: unknown): Args;
  /** Compute scene elements for these args. Coordinates are local
   * (origin at 0,0). The caller (`instantiate_template` in
   * whiteboard-mcp.ts) translates to scene-absolute. */
  layout(args: Args, sectionWidth: number): TemplateResult;
}

/** Helpers + constants shared across templates. Kept here so
 * individual template files don't need to coordinate constants. */
export const TEMPLATE_CONSTANTS = {
  /** Default per-char width estimate used for label-fit math at
   * fontSize=14 Excalifont mixed-case. Mirrors the calibration the
   * existing whiteboard-mcp wrappers use (LABEL_CHAR_W=10 at fs=16,
   * SUMMARY_CHAR_W=7.5 at fs=13). For our templates we work at fs=14
   * for body text and fs=16 for headers, so we keep one
   * conservative-Excalifont char_w slope:
   *   charW(fs) ≈ fs * 0.65  (Excalifont mixed-case, conservative)
   *   monoCharW(fs) ≈ fs * 0.6 (slightly tighter)
   * The renderer's actual char-fit may give a few px of slack inside
   * the box — we OVER-estimate so geometry never under-fits. */
  charW: (fontSize: number, mono: boolean = false): number =>
    fontSize * (mono ? 0.6 : 0.65),
  /** Standard line-height ratio used everywhere in this codebase. */
  LINE_HEIGHT_RATIO: 1.3,
  /** Excalidraw font-family constants (mirror whiteboard-mcp.ts). */
  FONT_EXCALIFONT: 5,
  FONT_HELVETICA: 1,
  FONT_MONO: 2,
} as const;

/** Wrap a string to a max line-width in chars (greedy word-wrap).
 * Mirrors the existing `wrapToWidth` in whiteboard-mcp.ts but operates
 * on a char-budget rather than a px-budget so templates can stay fully
 * pure (no font measurement deps). Lifted to `src/shared/whiteboard-text-fit.ts`
 * per Dedup B (#71); re-exported from this module so existing template
 * consumers don't churn their import paths. */
export { wrapToCharLimit } from '../../../shared/whiteboard-text-fit';

/** Stamp template metadata onto every element produced by a template
 * layout function so the renderer / AC layer / debugger can identify
 * elements as "template-emitted" and route them differently from
 * primitive-emitted ones. */
export function stampTemplate(
  els: SceneElement[],
  templateId: string,
  templateInstanceId: string,
): void {
  for (const el of els) {
    const cd = (el.customData ?? {}) as Record<string, unknown>;
    el.customData = {
      ...cd,
      // Don't clobber a more-specific fathomKind already stamped by the
      // template (e.g. wb-node, wb-callout) — append a templateId tag
      // that filters can read alongside the kind.
      templateId,
      templateInstanceId,
    };
  }
}
