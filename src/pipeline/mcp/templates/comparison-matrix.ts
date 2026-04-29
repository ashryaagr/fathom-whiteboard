/**
 * comparison-matrix template — rows × columns table with row/col
 * headers. For "ours vs prior work" / ablation tables.
 *
 * Layout: header row at top + N data rows below. Row label column at
 * left; cell columns to the right. Column widths are auto-fit to the
 * longest text per column (with floor at 120px). Cell heights default
 * to 60px. The row marked `isOurs: true` gets a soft warm-yellow
 * background to draw the eye.
 *
 * Bbox: width = rowLabelWidth + sum(colWidths) + 2*PAD;
 *       height = (n_rows + 1) * 60 + 2*PAD.
 */

import type { SceneElement, TemplateDef, TemplateResult } from './types';
import { TEMPLATE_CONSTANTS, wrapToCharLimit } from './types';

const PAD = 16;
const ROW_HEIGHT = 60;
const HEADER_FONT = 14;
const CELL_FONT = 13;
const CELL_INNER_PAD_X = 12;
const CELL_INNER_PAD_Y = 8;
const MIN_COL_WIDTH = 120;
const MAX_COL_WIDTH = 240;

type CellRole = 'good' | 'bad' | 'neutral';

interface MatrixCell {
  text: string;
  role?: CellRole;
}

interface MatrixRow {
  label: string;
  cells: MatrixCell[];
  isOurs?: boolean;
}

export interface ComparisonMatrixArgs {
  rowHeader: string;
  columnHeaders: string[];
  rows: MatrixRow[];
}

function cellFillForRole(role: CellRole | undefined, isOurs: boolean): string {
  if (isOurs) return '#fef3c7'; // warm yellow tint for the "ours" row
  switch (role) {
    case 'good':    return '#d3f9d8';
    case 'bad':     return '#ffe3e3';
    case 'neutral':
    default:        return '#ffffff';
  }
}

function validate(args: unknown): ComparisonMatrixArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('comparison-matrix: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.rowHeader !== 'string') {
    throw new Error('comparison-matrix: args.rowHeader must be a string');
  }
  if (!Array.isArray(a.columnHeaders) || a.columnHeaders.length === 0) {
    throw new Error('comparison-matrix: args.columnHeaders must be non-empty array');
  }
  for (let i = 0; i < a.columnHeaders.length; i += 1) {
    if (typeof a.columnHeaders[i] !== 'string') {
      throw new Error(`comparison-matrix: columnHeaders[${i}] must be a string`);
    }
  }
  if (a.columnHeaders.length > 5) {
    throw new Error(`comparison-matrix: max 5 columns (got ${a.columnHeaders.length})`);
  }
  if (!Array.isArray(a.rows) || a.rows.length === 0) {
    throw new Error('comparison-matrix: args.rows must be a non-empty array');
  }
  if (a.rows.length > 8) {
    throw new Error(`comparison-matrix: max 8 rows (got ${a.rows.length})`);
  }
  const columnHeaders = a.columnHeaders as string[];
  const rows: MatrixRow[] = a.rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`comparison-matrix: rows[${i}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.label !== 'string') {
      throw new Error(`comparison-matrix: rows[${i}].label must be a string`);
    }
    if (!Array.isArray(r.cells)) {
      throw new Error(`comparison-matrix: rows[${i}].cells must be an array`);
    }
    if (r.cells.length !== columnHeaders.length) {
      throw new Error(
        `comparison-matrix: rows[${i}] has ${r.cells.length} cells; expected ${columnHeaders.length} (one per column header)`,
      );
    }
    const cells: MatrixCell[] = r.cells.map((cellRaw, j) => {
      if (!cellRaw || typeof cellRaw !== 'object') {
        throw new Error(`comparison-matrix: rows[${i}].cells[${j}] must be an object`);
      }
      const c = cellRaw as Record<string, unknown>;
      if (typeof c.text !== 'string') {
        throw new Error(`comparison-matrix: rows[${i}].cells[${j}].text must be a string`);
      }
      const roleRaw = c.role;
      const role: CellRole | undefined =
        roleRaw === 'good' || roleRaw === 'bad' || roleRaw === 'neutral' ? roleRaw : undefined;
      return { text: c.text, role };
    });
    return {
      label: r.label,
      cells,
      isOurs: r.isOurs === true,
    };
  });
  return {
    rowHeader: a.rowHeader,
    columnHeaders,
    rows,
  };
}

/** Estimate col-or-row-label width from the longest string it must
 * hold, with min/max clamps. */
function pixelWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * TEMPLATE_CONSTANTS.charW(fontSize));
}

function colWidth(headerText: string, cellTexts: string[]): number {
  const longestPx = Math.max(
    pixelWidth(headerText, HEADER_FONT),
    ...cellTexts.map((t) => pixelWidth(t, CELL_FONT)),
    0,
  );
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, longestPx + 2 * CELL_INNER_PAD_X));
}

function layout(args: ComparisonMatrixArgs, _sectionWidth: number): TemplateResult {
  const elements: SceneElement[] = [];
  const warnings: string[] = [];

  // Compute column widths.
  const rowLabelW = colWidth(
    args.rowHeader,
    args.rows.map((r) => r.label),
  );
  const colWs = args.columnHeaders.map((h, j) =>
    colWidth(
      h,
      args.rows.map((r) => r.cells[j].text),
    ),
  );

  const totalW = PAD + rowLabelW + colWs.reduce((s, w) => s + w, 0) + PAD;
  const totalH = PAD + (args.rows.length + 1) * ROW_HEIGHT + PAD;

  // Helper: emit a cell rect + a centered text element.
  const emitCell = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    fontSize: number,
    fontFamily: number,
    bg: string,
    bold: boolean,
  ): void => {
    elements.push({
      type: 'rectangle',
      id,
      x,
      y,
      width: w,
      height: h,
      strokeColor: '#5a4a3a',
      backgroundColor: bg,
      strokeWidth: 1,
      strokeStyle: 'solid',
      roundness: null,
      roughness: 0,
      fillStyle: 'solid',
      boundElements: [],
      customData: {
        fathomKind: 'wb-matrix-cell',
        bold,
      },
    } as unknown as SceneElement);
    // Wrap the text to the cell's inner width budget.
    const innerCharBudget = Math.max(
      4,
      Math.floor((w - 2 * CELL_INNER_PAD_X) / TEMPLATE_CONSTANTS.charW(fontSize)),
    );
    const lines = wrapToCharLimit(text, innerCharBudget);
    // Center the text vertically by offsetting from the top.
    const lineH = Math.ceil(fontSize * TEMPLATE_CONSTANTS.LINE_HEIGHT_RATIO);
    const textBlockH = lines.length * lineH;
    const textY = y + Math.max(CELL_INNER_PAD_Y, (h - textBlockH) / 2);
    elements.push({
      type: 'text',
      id: `${id}-text`,
      x: x + CELL_INNER_PAD_X,
      y: textY,
      width: w - 2 * CELL_INNER_PAD_X,
      height: textBlockH,
      text: lines.join('\n'),
      originalText: lines.join('\n'),
      autoResize: false,
      fontSize,
      fontFamily,
      textAlign: 'center',
      verticalAlign: 'top',
      strokeColor: '#1a1614',
      containerId: null,
      customData: {
        fathomKind: 'wb-matrix-text',
      },
    } as SceneElement);
  };

  // Header row.
  let cx = PAD;
  emitCell(
    'tpl-matrix-rh',
    cx,
    PAD,
    rowLabelW,
    ROW_HEIGHT,
    args.rowHeader,
    HEADER_FONT,
    TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
    '#f4efe8',
    true,
  );
  cx += rowLabelW;
  for (let j = 0; j < args.columnHeaders.length; j += 1) {
    emitCell(
      `tpl-matrix-ch-${j}`,
      cx,
      PAD,
      colWs[j],
      ROW_HEIGHT,
      args.columnHeaders[j],
      HEADER_FONT,
      TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
      '#f4efe8',
      true,
    );
    cx += colWs[j];
  }

  // Data rows.
  for (let i = 0; i < args.rows.length; i += 1) {
    const row = args.rows[i];
    const rowY = PAD + (i + 1) * ROW_HEIGHT;
    cx = PAD;
    emitCell(
      `tpl-matrix-r${i}-label`,
      cx,
      rowY,
      rowLabelW,
      ROW_HEIGHT,
      row.label,
      HEADER_FONT,
      TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
      row.isOurs ? '#fef3c7' : '#fcfaf5',
      true,
    );
    cx += rowLabelW;
    for (let j = 0; j < row.cells.length; j += 1) {
      const cell = row.cells[j];
      emitCell(
        `tpl-matrix-r${i}-c${j}`,
        cx,
        rowY,
        colWs[j],
        ROW_HEIGHT,
        cell.text,
        CELL_FONT,
        TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
        cellFillForRole(cell.role, row.isOurs === true),
        false,
      );
      cx += colWs[j];
    }
  }

  if (args.rows.length > 5) {
    warnings.push(`comparison-matrix: ${args.rows.length} rows is dense; consider splitting.`);
  }

  return {
    elements,
    bbox: { width: totalW, height: totalH },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const comparisonMatrixTemplate: TemplateDef<ComparisonMatrixArgs> = {
  id: 'comparison-matrix',
  name: 'Comparison matrix / vs table',
  validate,
  layout,
};
