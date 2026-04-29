/**
 * Text-wrapping + node-sizing helpers shared between the MCP wrapper
 * (main process, char-width approximation) and the renderer's ELK
 * layout (Canvas-2D measurement). Lifted from `whiteboard-mcp.ts` and
 * `elkLayout.ts` per Dedup B (#71).
 *
 * Both consumers compute the same dimensions; the only difference is
 * how they measure text width. The injection point is the optional
 * `measure` callback on `fitNodeSize` — when supplied, it's used (the
 * renderer passes a Canvas-2D context); when omitted, we fall back to
 * `length * charW` (the MCP approximation).
 *
 * `wrapToWidth` keeps the MCP-side 3-arg signature `(text, charW,
 * maxInnerWidth)` because it has three call sites in `whiteboard-mcp.ts`
 * with different per-callsite char-widths (`LABEL_CHAR_W`,
 * `NODE_QUESTION_CHAR_W`, `CALLOUT_BODY_CHAR_W`). The renderer uses a
 * 4-arg variant with real measurement; we keep that path local to the
 * renderer (see `wrapToWidthMeasured` below) so both paths share this
 * file but neither bends to fit the other.
 *
 * `LINE_HEIGHT_RATIO` is fixed at 1.3 — matches MCP's authoring-time
 * computation. Renderer previously used 1.25; consolidating means
 * future renderer-side renders gain ~3% in node height, consistent
 * with what MCP told the agent the dimensions would be at authoring.
 */

/** Line-height multiplier used by every node-sizing path in the
 * whiteboard pipeline. Mirrors what Excalidraw's bound-text element
 * uses internally; consolidating here means MCP authoring-time
 * dimensions agree with renderer-side layout dimensions. */
export const LINE_HEIGHT_RATIO = 1.3;

/** Greedy word-wrap on a char-budget. `charW` is the per-character
 * width estimate at the rendered font size; `maxInnerWidth` is the
 * pixel budget inside the rect (already minus padding). Returns the
 * lines as an array. Empty input → one empty line. */
export function wrapToWidth(
  text: string,
  charW: number,
  maxInnerWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const trial = current ? current + ' ' + w : w;
    if (trial.length * charW <= maxInnerWidth || current === '') {
      current = trial;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Char-budget variant of `wrapToWidth` — caller passes a
 * max-chars-per-line directly. Used by the MCP templates module
 * which is intentionally font-measurement-free (templates are pure
 * functions of args + section width; no Canvas, no charW lookup). */
export function wrapToCharLimit(text: string, maxChars: number): string[] {
  if (maxChars < 1) return [text];
  return wrapToWidth(text, 1, maxChars);
}

/** Per-callsite measurement strategy — `(text, fontSize, family) => px`.
 * Renderer passes a Canvas-2D-backed measurer; MCP omits it and
 * falls back to `length * dims.summaryCharW`. */
export type TextMeasurer = (text: string, fontSize: number, family: string) => number;

/** Dimension knobs `fitNodeSize` consumes. Both consumers pass the
 * same numbers today (NODE_MIN_WIDTH=180, NODE_MAX_WIDTH=320, etc.) so
 * making them parameters keeps the helper module truly generic without
 * either consumer needing to import the other's constants. */
export interface FitNodeDims {
  NODE_MIN_WIDTH: number;
  NODE_MAX_WIDTH: number;
  NODE_MIN_HEIGHT: number;
  NODE_INNER_PAD_X: number;
  NODE_INNER_PAD_Y: number;
  LABEL_FONT: number;
  SUMMARY_FONT: number;
  /** Per-character width estimate for the label font. MCP uses 10
   * (≈ 16 px Excalifont mixed-case). Ignored when `measure` is
   * supplied. */
  LABEL_CHAR_W: number;
  /** Per-character width estimate for the summary font. MCP uses 7.5
   * (≈ 13 px Helvetica). Ignored when `measure` is supplied. */
  SUMMARY_CHAR_W: number;
  /** Optional font families for `measure` callers. Renderer passes
   * cursive/Excalifont for label and Helvetica for summary; MCP
   * ignores these. */
  LABEL_FAMILY?: string;
  SUMMARY_FAMILY?: string;
}

/** Pick the smallest rect dimensions that GUARANTEE the label +
 * (optional) summary fit inside without overflow. Iterates rect
 * widths in 20 px steps from the label's natural width to NODE_MAX_WIDTH,
 * preferring a 2-line summary, allowing 3 lines with ellipsis if
 * a 3rd line is needed.
 *
 * Returns `{w, h, summaryLines}`. The renderer ignores
 * `summaryLines`; the MCP uses it to write the bound text. */
export function fitNodeSize(
  label: string,
  summary: string,
  dims: FitNodeDims,
  measure?: TextMeasurer,
): { w: number; h: number; summaryLines: string[] } {
  const labelFamily = dims.LABEL_FAMILY ?? '';
  const summaryFamily = dims.SUMMARY_FAMILY ?? '';

  const measureLabel = (text: string): number =>
    measure ? measure(text, dims.LABEL_FONT, labelFamily) : text.length * dims.LABEL_CHAR_W;
  const measureSummary = (text: string): number =>
    measure ? measure(text, dims.SUMMARY_FONT, summaryFamily) : text.length * dims.SUMMARY_CHAR_W;

  const labelOneLine = measureLabel(label);
  let chosenInnerW = Math.min(
    dims.NODE_MAX_WIDTH - 2 * dims.NODE_INNER_PAD_X,
    Math.max(labelOneLine, dims.NODE_MIN_WIDTH - 2 * dims.NODE_INNER_PAD_X),
  );

  let summaryLines: string[] = [];
  if (summary) {
    for (
      let probeW = chosenInnerW;
      probeW <= dims.NODE_MAX_WIDTH - 2 * dims.NODE_INNER_PAD_X;
      probeW += 20
    ) {
      const lines = wrapForBudget(summary, probeW, dims.SUMMARY_CHAR_W, dims.SUMMARY_FONT, summaryFamily, measure);
      if (lines.length <= 2) {
        chosenInnerW = probeW;
        summaryLines = lines;
        break;
      }
      if (probeW + 20 > dims.NODE_MAX_WIDTH - 2 * dims.NODE_INNER_PAD_X) {
        chosenInnerW = probeW;
        summaryLines = lines.slice(0, 3);
        if (lines.length > 3) {
          summaryLines[2] = summaryLines[2].replace(/\s+\S*$/, '') + '…';
        }
        break;
      }
    }
    for (const ln of summaryLines) {
      const lnW = measureSummary(ln);
      if (lnW > chosenInnerW) {
        chosenInnerW = Math.min(lnW, dims.NODE_MAX_WIDTH - 2 * dims.NODE_INNER_PAD_X);
      }
    }
  }

  const w = Math.min(dims.NODE_MAX_WIDTH, chosenInnerW + 2 * dims.NODE_INNER_PAD_X);
  const labelLineH = dims.LABEL_FONT * LINE_HEIGHT_RATIO;
  const summaryLineH = dims.SUMMARY_FONT * LINE_HEIGHT_RATIO;
  const textH = labelLineH + (summary ? 6 + summaryLines.length * summaryLineH : 0);
  const h = Math.max(dims.NODE_MIN_HEIGHT, Math.ceil(textH + 2 * dims.NODE_INNER_PAD_Y));

  return { w, h, summaryLines };
}

/** Internal: wrap respecting the chosen measurement strategy. When
 * `measure` is supplied, uses real font measurement; otherwise falls
 * back to `wrapToWidth`'s charW * length approximation. */
function wrapForBudget(
  text: string,
  maxInnerWidth: number,
  charW: number,
  fontSize: number,
  family: string,
  measure?: TextMeasurer,
): string[] {
  if (!measure) return wrapToWidth(text, charW, maxInnerWidth);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const trial = current ? current + ' ' + w : w;
    if (measure(trial, fontSize, family) <= maxInnerWidth || current === '') {
      current = trial;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}
