/**
 * key-insight-callout template — single tinted rectangle holding a
 * one-sentence headline + 1-3 sentence body. Promoted from the existing
 * `create_callout_box` primitive into a first-class template for
 * symmetry with the other P0 templates.
 *
 * Layout: a single tinted rectangle. Tag at top-left ("KEY INSIGHT"
 * uppercase, small). Body below the tag in regular Excalifont. Width
 * auto-fits to the body's wrap budget (capped at 640).
 *
 * Bbox: width = clamp(min content width, 640); height = tag-row +
 * body-rows + 2*pad.
 */

import type { SceneElement, TemplateDef, TemplateResult } from './types';
import { TEMPLATE_CONSTANTS, wrapToCharLimit } from './types';

const PAD = 16;
const TAG_FONT = 13;
const BODY_FONT = 16;
const BODY_PAD_X = 20;
const BODY_PAD_Y_TOP = 42; // tag row height + gap
const BODY_PAD_Y_BOTTOM = 24;
const MAX_WIDTH = 720;

type Tint = 'green' | 'yellow' | 'peach';

export interface KeyInsightCalloutArgs {
  body: string;
  tag?: string;
  tint?: Tint;
  /** v2 placeholder per template-catalog: linkedRefs is reserved for
   * cross-template wiring (a callout referencing nodes in a sibling
   * flow-chart). For round 13 the field is accepted and ignored;
   * round 14 (L2) will wire it. */
  linkedRefs?: unknown;
}

interface TintPalette {
  fill: string;
  stroke: string;
  tagColor: string;
}

function paletteForTint(tint: Tint): TintPalette {
  switch (tint) {
    case 'yellow':
      return { fill: '#fff9db', stroke: '#f59e0b', tagColor: '#9f661b' };
    case 'peach':
      return { fill: '#ffe8d6', stroke: '#d4793a', tagColor: '#9f4a1a' };
    case 'green':
    default:
      return { fill: '#d3f9d8', stroke: '#22c55e', tagColor: '#15803d' };
  }
}

function validate(args: unknown): KeyInsightCalloutArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('key-insight-callout: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.body !== 'string' || a.body.length === 0) {
    throw new Error('key-insight-callout: args.body must be a non-empty string');
  }
  if (a.body.length > 800) {
    throw new Error(`key-insight-callout: body too long (${a.body.length} > 800 chars)`);
  }
  const tag = typeof a.tag === 'string' ? a.tag.slice(0, 20) : 'KEY INSIGHT';
  const tintRaw = a.tint;
  const tint: Tint =
    tintRaw === 'yellow' || tintRaw === 'peach' || tintRaw === 'green' ? tintRaw : 'green';
  return {
    body: a.body,
    tag,
    tint,
    linkedRefs: a.linkedRefs,
  };
}

function layout(args: KeyInsightCalloutArgs, sectionWidth: number): TemplateResult {
  const elements: SceneElement[] = [];
  // Pick a width: prefer max content width but cap at MAX_WIDTH and
  // never exceed (sectionWidth - 2*PAD). The actual emitted body wraps
  // to the chosen inner width.
  const idealW = Math.min(MAX_WIDTH, Math.max(360, sectionWidth - 2 * PAD));
  const innerW = idealW - 2 * BODY_PAD_X;
  const charBudget = Math.max(20, Math.floor(innerW / TEMPLATE_CONSTANTS.charW(BODY_FONT)));
  const lineH = Math.ceil(BODY_FONT * 1.5);

  // Wrap each \n-paragraph independently and sum.
  const reflowed: string[] = [];
  let totalLines = 0;
  for (const para of args.body.split('\n')) {
    const wrapped = wrapToCharLimit(para.length === 0 ? ' ' : para, charBudget);
    totalLines += Math.max(1, wrapped.length);
    reflowed.push(wrapped.join('\n'));
  }
  const body = reflowed.join('\n');
  totalLines = Math.max(2, totalLines);

  const bodyHeight = totalLines * lineH + 16;
  const totalHeight = Math.max(120, BODY_PAD_Y_TOP + bodyHeight + BODY_PAD_Y_BOTTOM);
  const pal = paletteForTint(args.tint ?? 'green');
  const tag = (args.tag ?? 'KEY INSIGHT').toUpperCase().slice(0, 20);

  // 1. The tinted box itself.
  elements.push({
    type: 'rectangle',
    id: 'tpl-callout-box',
    x: 0,
    y: 0,
    width: idealW,
    height: totalHeight,
    strokeColor: pal.stroke,
    backgroundColor: pal.fill,
    strokeWidth: 2,
    strokeStyle: 'solid',
    roundness: { type: 3 },
    roughness: 0,
    fillStyle: 'solid',
    boundElements: [],
    customData: {
      fathomKind: 'wb-callout',
      role: 'output',
      tag,
    },
  } as unknown as SceneElement);

  // 2. Tag chip — small uppercase top-left.
  elements.push({
    type: 'text',
    id: 'tpl-callout-tag',
    x: BODY_PAD_X,
    y: 14,
    width: Math.min(idealW - 2 * BODY_PAD_X, 240),
    height: 18,
    text: tag,
    originalText: tag,
    autoResize: false,
    fontSize: TAG_FONT,
    fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
    textAlign: 'left',
    verticalAlign: 'top',
    strokeColor: pal.tagColor,
    containerId: null,
    customData: { fathomKind: 'wb-callout-tag' },
  } as SceneElement);

  // 3. Body text.
  elements.push({
    type: 'text',
    id: 'tpl-callout-body',
    x: BODY_PAD_X,
    y: BODY_PAD_Y_TOP,
    width: idealW - 2 * BODY_PAD_X,
    height: bodyHeight,
    text: body,
    originalText: body,
    autoResize: false,
    fontSize: BODY_FONT,
    fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
    textAlign: 'left',
    verticalAlign: 'top',
    strokeColor: '#1a1614',
    containerId: null,
    customData: { fathomKind: 'wb-callout-body' },
  } as SceneElement);

  return {
    elements,
    bbox: { width: idealW, height: totalHeight },
  };
}

export const keyInsightCalloutTemplate: TemplateDef<KeyInsightCalloutArgs> = {
  id: 'key-insight-callout',
  name: 'Key insight / KEY IDEA callout',
  validate,
  layout,
};
