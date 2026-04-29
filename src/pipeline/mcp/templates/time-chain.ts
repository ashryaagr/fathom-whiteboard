/**
 * time-chain template — horizontal timeline with N tick events.
 *
 * Layout: a horizontal axis arrow at vertical midpoint, with N tick
 * markers (small circles) evenly distributed along it. Each tick has:
 *   - a "tick" label above the marker (e.g. t=0, t=1, t=T)
 *   - a "title" text below the marker
 *   - an optional "body" text below the title
 *
 * The axis itself is rendered as a single arrow (start → end).
 * `axisLabel` floats above the axis at the right end.
 *
 * Bbox: width = max(1100, n * TICK_GAP + 2*PAD); height ≈ 200.
 */

import type { SceneElement, TemplateDef, TemplateResult } from './types';
import { TEMPLATE_CONSTANTS, wrapToCharLimit } from './types';

const PAD = 16;
const TICK_GAP = 220;
const TICK_RADIUS = 8;
const TICK_LABEL_FONT = 12;
const TITLE_FONT = 14;
const BODY_FONT = 12;
const AXIS_LABEL_FONT = 12;

const AXIS_Y = 100;             // y of the axis line
const TICK_LABEL_Y_OFFSET = -28; // tick label sits above marker
const TITLE_Y_OFFSET = 16;       // title sits below marker
const TITLE_BLOCK_H = 22;
const BODY_GAP = 4;
const BODY_BLOCK_H = 56;

interface TimeChainEvent {
  tick: string;
  title: string;
  body?: string;
}

export interface TimeChainArgs {
  axisLabel: string;
  events: TimeChainEvent[];
  direction?: 'horizontal' | 'vertical';
}

function validate(args: unknown): TimeChainArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('time-chain: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.axisLabel !== 'string') {
    throw new Error('time-chain: args.axisLabel must be a string');
  }
  if (!Array.isArray(a.events) || a.events.length < 2) {
    throw new Error('time-chain: args.events must have ≥2 items');
  }
  if (a.events.length > 8) {
    throw new Error(`time-chain: max 8 events (got ${a.events.length})`);
  }
  const events: TimeChainEvent[] = a.events.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`time-chain: events[${i}] must be an object`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.tick !== 'string' || typeof e.title !== 'string') {
      throw new Error(`time-chain: events[${i}] requires string tick + title`);
    }
    return {
      tick: e.tick,
      title: e.title,
      body: typeof e.body === 'string' ? e.body : undefined,
    };
  });
  const direction = a.direction === 'vertical' ? 'vertical' : 'horizontal';
  if (direction === 'vertical') {
    throw new Error('time-chain: direction=vertical not yet implemented (round 13 ships horizontal only)');
  }
  return {
    axisLabel: a.axisLabel,
    events,
    direction,
  };
}

function layout(args: TimeChainArgs, _sectionWidth: number): TemplateResult {
  const elements: SceneElement[] = [];
  const warnings: string[] = [];

  const n = args.events.length;
  const totalWidth = Math.max(1100, n * TICK_GAP + 2 * PAD);
  const axisStartX = PAD;
  const axisEndX = totalWidth - PAD;
  const axisLen = axisEndX - axisStartX;
  const tickXs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    // Distribute ticks evenly along the axis.
    tickXs.push(axisStartX + (axisLen * (i + 0.5)) / n);
  }

  // Body text is wrapped to a budget that fits within the per-tick
  // column (column = TICK_GAP - some slack for breathing room).
  const COL_WIDTH = Math.min(TICK_GAP - 24, 200);
  const bodyCharBudget = Math.max(
    8,
    Math.floor(COL_WIDTH / TEMPLATE_CONSTANTS.charW(BODY_FONT)),
  );

  // Compute the max body height across events, so the bbox is correct.
  let maxBodyLines = 0;
  for (const e of args.events) {
    if (!e.body) continue;
    const lines = wrapToCharLimit(e.body, bodyCharBudget);
    if (lines.length > maxBodyLines) maxBodyLines = lines.length;
  }
  const bodyLineH = Math.ceil(BODY_FONT * TEMPLATE_CONSTANTS.LINE_HEIGHT_RATIO);
  const bodyBlockH = maxBodyLines > 0 ? Math.max(BODY_BLOCK_H, maxBodyLines * bodyLineH + 4) : 0;
  const totalHeight = AXIS_Y + TITLE_Y_OFFSET + TITLE_BLOCK_H + BODY_GAP + bodyBlockH + PAD;

  // 1. Axis label (above axis, near right end). Right-aligned visually
  // by computing predicted text width and anchoring x so the right edge
  // sits at axisEndX. SceneText only allows left|center alignment.
  const axisLblText = args.axisLabel;
  const axisLblPredictedW = Math.ceil(
    axisLblText.length * TEMPLATE_CONSTANTS.charW(AXIS_LABEL_FONT),
  );
  const axisLblBoxW = Math.min(240, Math.max(80, axisLblPredictedW + 8));
  elements.push({
    type: 'text',
    id: 'tpl-tc-axis-label',
    x: axisEndX - axisLblBoxW,
    y: AXIS_Y - 36,
    width: axisLblBoxW,
    height: 18,
    text: axisLblText,
    originalText: axisLblText,
    autoResize: false,
    fontSize: AXIS_LABEL_FONT,
    fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
    textAlign: 'left',
    verticalAlign: 'top',
    strokeColor: '#5a4a3a',
    containerId: null,
    customData: { fathomKind: 'wb-axis-label' },
  } as SceneElement);

  // 2. Axis arrow.
  elements.push({
    type: 'arrow',
    id: 'tpl-tc-axis',
    x: axisStartX,
    y: AXIS_Y,
    points: [
      [0, 0],
      [axisLen, 0],
    ],
    strokeColor: '#1a1614',
    strokeWidth: 1.2,
    roughness: 1,
    startBinding: null,
    endBinding: null,
    customData: { fathomKind: 'wb-axis' },
  } as SceneElement);

  // 3. Tick markers + labels + titles + bodies.
  for (let i = 0; i < n; i += 1) {
    const e = args.events[i];
    const tx = tickXs[i];
    // Marker (small ellipse rendered as rounded rect) — easier than
    // the renderer's ellipse path which we don't share here.
    elements.push({
      type: 'rectangle',
      id: `tpl-tc-marker-${i}`,
      x: tx - TICK_RADIUS,
      y: AXIS_Y - TICK_RADIUS,
      width: TICK_RADIUS * 2,
      height: TICK_RADIUS * 2,
      strokeColor: '#1a1614',
      backgroundColor: '#1a1614',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roundness: { type: 3 },
      roughness: 0,
      fillStyle: 'solid',
      boundElements: [],
      customData: { fathomKind: 'wb-tick-marker' },
    } as unknown as SceneElement);

    // Tick label (e.g. "t=0") above the marker.
    elements.push({
      type: 'text',
      id: `tpl-tc-tick-${i}`,
      x: tx - 40,
      y: AXIS_Y + TICK_LABEL_Y_OFFSET,
      width: 80,
      height: 18,
      text: e.tick,
      originalText: e.tick,
      autoResize: false,
      fontSize: TICK_LABEL_FONT,
      fontFamily: TEMPLATE_CONSTANTS.FONT_HELVETICA,
      textAlign: 'center',
      verticalAlign: 'top',
      strokeColor: '#5a4a3a',
      containerId: null,
      customData: { fathomKind: 'wb-tick-label' },
    } as SceneElement);

    // Title BELOW the marker, centered.
    const titleW = COL_WIDTH;
    const titleText = e.title.length > 32 ? e.title.slice(0, 31) + '…' : e.title;
    elements.push({
      type: 'text',
      id: `tpl-tc-title-${i}`,
      x: tx - titleW / 2,
      y: AXIS_Y + TITLE_Y_OFFSET,
      width: titleW,
      height: TITLE_BLOCK_H,
      text: titleText,
      originalText: titleText,
      autoResize: false,
      fontSize: TITLE_FONT,
      fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
      textAlign: 'center',
      verticalAlign: 'top',
      strokeColor: '#1a1614',
      containerId: null,
      customData: { fathomKind: 'wb-tick-title' },
    } as SceneElement);

    // Body (optional).
    if (e.body) {
      const lines = wrapToCharLimit(e.body, bodyCharBudget);
      const bodyText = lines.join('\n');
      elements.push({
        type: 'text',
        id: `tpl-tc-body-${i}`,
        x: tx - COL_WIDTH / 2,
        y: AXIS_Y + TITLE_Y_OFFSET + TITLE_BLOCK_H + BODY_GAP,
        width: COL_WIDTH,
        height: lines.length * bodyLineH + 4,
        text: bodyText,
        originalText: bodyText,
        autoResize: false,
        fontSize: BODY_FONT,
        fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
        textAlign: 'center',
        verticalAlign: 'top',
        strokeColor: '#5a4a3a',
        containerId: null,
        customData: { fathomKind: 'wb-tick-body' },
      } as SceneElement);
    }
  }

  if (n > 6) {
    warnings.push(`time-chain: ${n} ticks is dense; consider sampling to 5-6 representative steps.`);
  }

  return {
    elements,
    bbox: { width: totalWidth, height: totalHeight },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const timeChainTemplate: TemplateDef<TimeChainArgs> = {
  id: 'time-chain',
  name: 'Time chain / iterative refinement',
  validate,
  layout,
};
