/**
 * flow-chart template — N nodes connected by arrows, optional zones.
 *
 * Layout: nodes arranged horizontally with NODE_GAP between them.
 *   - input nodes: 120 × 80 ellipse-style (rounded rect, lighter stroke)
 *   - process nodes: 160 × 100 rect
 *   - output nodes: 140 × 80 hexagon-stylised rect (we don't have a
 *     hexagon primitive; use a rect with bolder stroke as the visual
 *     differentiator — the role color carries the rest)
 * Connections drawn with straight arrows (the existing renderer will
 * elbow them at render time if start/end Y differ).
 * Zones drawn as background rects with 20px-padding around their
 * member nodes; zone label rendered above the zone.
 *
 * Bbox: width = sum(node_widths) + (n-1)*GAP + 2*PAD; height = max
 * node_height + 80 (zone label) + 60 (arrow labels above) ≈ 240.
 */

import type { SceneElement, TemplateDef, TemplateResult } from './types';
import { TEMPLATE_CONSTANTS, wrapToCharLimit } from './types';

const NODE_GAP = 60;
const PAD = 16; // outer padding inside the section content area
const LABEL_FONT = 14;
const SUMMARY_FONT = 12;
const ZONE_LABEL_FONT = 11;
const ARROW_LABEL_FONT = 11;

type Role = 'input' | 'process' | 'output' | 'model';

interface FlowNode {
  label: string;
  role: Role;
  question?: string;
  drillable?: boolean;
}

interface FlowConnection {
  fromIdx: number;
  toIdx: number;
  label?: string;
}

interface FlowZone {
  startIdx: number;
  endIdx: number;
  role: 'background' | 'highlight' | 'critical';
  label: string;
}

export interface FlowChartArgs {
  nodes: FlowNode[];
  connections?: FlowConnection[];
  zones?: FlowZone[];
}

interface NodeStyle {
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  rounded: boolean;
}

function styleForRole(role: Role): NodeStyle {
  switch (role) {
    case 'input':
      return {
        width: 120, height: 80, fill: '#a5d8ff', stroke: '#4a9eed',
        strokeWidth: 1, rounded: true,
      };
    case 'output':
      return {
        width: 140, height: 80, fill: '#b2f2bb', stroke: '#22c55e',
        strokeWidth: 2, rounded: true,
      };
    case 'model':
      return {
        width: 160, height: 100, fill: '#fef4d8', stroke: '#f59e0b',
        strokeWidth: 2, rounded: true,
      };
    case 'process':
    default:
      return {
        width: 160, height: 100, fill: '#d0bfff', stroke: '#8b5cf6',
        strokeWidth: 1, rounded: true,
      };
  }
}

function zoneFillForRole(role: 'background' | 'highlight' | 'critical'): string {
  switch (role) {
    case 'highlight': return '#fff9db'; // soft yellow
    case 'critical':  return '#ffe3e3'; // soft red
    case 'background':
    default:          return '#f4efe8'; // soft warm neutral
  }
}

function validate(args: unknown): FlowChartArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('flow-chart: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a.nodes) || a.nodes.length === 0) {
    throw new Error('flow-chart: args.nodes must be a non-empty array');
  }
  if (a.nodes.length > 8) {
    throw new Error(`flow-chart: args.nodes max 8 (got ${a.nodes.length})`);
  }
  const nodes: FlowNode[] = a.nodes.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`flow-chart: nodes[${i}] must be an object`);
    }
    const n = raw as Record<string, unknown>;
    if (typeof n.label !== 'string' || n.label.length === 0) {
      throw new Error(`flow-chart: nodes[${i}].label must be a non-empty string`);
    }
    if (typeof n.role !== 'string' || !['input', 'process', 'output', 'model'].includes(n.role)) {
      throw new Error(`flow-chart: nodes[${i}].role must be one of input|process|output|model`);
    }
    return {
      label: n.label,
      role: n.role as Role,
      question: typeof n.question === 'string' ? n.question : undefined,
      drillable: typeof n.drillable === 'boolean' ? n.drillable : undefined,
    };
  });
  const connections: FlowConnection[] = Array.isArray(a.connections)
    ? a.connections.map((raw, i) => {
        if (!raw || typeof raw !== 'object') {
          throw new Error(`flow-chart: connections[${i}] must be an object`);
        }
        const c = raw as Record<string, unknown>;
        if (typeof c.fromIdx !== 'number' || typeof c.toIdx !== 'number') {
          throw new Error(`flow-chart: connections[${i}] requires numeric fromIdx + toIdx`);
        }
        if (c.fromIdx < 0 || c.fromIdx >= nodes.length || c.toIdx < 0 || c.toIdx >= nodes.length) {
          throw new Error(
            `flow-chart: connections[${i}] indices out of range (have ${nodes.length} nodes)`,
          );
        }
        return {
          fromIdx: c.fromIdx,
          toIdx: c.toIdx,
          label: typeof c.label === 'string' ? c.label : undefined,
        };
      })
    : [];
  const zones: FlowZone[] = Array.isArray(a.zones)
    ? a.zones.map((raw, i) => {
        if (!raw || typeof raw !== 'object') {
          throw new Error(`flow-chart: zones[${i}] must be an object`);
        }
        const z = raw as Record<string, unknown>;
        if (typeof z.startIdx !== 'number' || typeof z.endIdx !== 'number') {
          throw new Error(`flow-chart: zones[${i}] requires numeric startIdx + endIdx`);
        }
        if (z.startIdx > z.endIdx || z.startIdx < 0 || z.endIdx >= nodes.length) {
          throw new Error(`flow-chart: zones[${i}] invalid range`);
        }
        if (typeof z.label !== 'string') {
          throw new Error(`flow-chart: zones[${i}].label must be a string`);
        }
        const role = z.role;
        if (role !== 'background' && role !== 'highlight' && role !== 'critical') {
          throw new Error(`flow-chart: zones[${i}].role must be background|highlight|critical`);
        }
        return { startIdx: z.startIdx, endIdx: z.endIdx, role, label: z.label };
      })
    : [];
  return { nodes, connections, zones };
}

function layout(args: FlowChartArgs, _sectionWidth: number): TemplateResult {
  const elements: SceneElement[] = [];
  const warnings: string[] = [];

  // Reserve a vertical band above the nodes for arrow labels (60) and
  // zone labels (24). Nodes sit BELOW this band so labels never collide
  // with the node row.
  const ARROW_LABEL_BAND_H = args.connections && args.connections.some((c) => c.label) ? 24 : 0;
  const ZONE_LABEL_BAND_H = args.zones && args.zones.length > 0 ? 24 : 0;
  const nodeRowY = ZONE_LABEL_BAND_H + ARROW_LABEL_BAND_H;

  // Compute node positions + styles.
  const styles = args.nodes.map((n) => styleForRole(n.role));
  const xs: number[] = [];
  let cursorX = PAD;
  for (let i = 0; i < args.nodes.length; i += 1) {
    xs.push(cursorX);
    cursorX += styles[i].width + (i < args.nodes.length - 1 ? NODE_GAP : 0);
  }
  const totalWidth = cursorX + PAD;
  const maxNodeH = Math.max(...styles.map((s) => s.height));

  // Question subtitle band BELOW the nodes — same pattern as
  // create_node_with_fitted_text. ~36px per node that has a question.
  const QUESTION_BAND_H = args.nodes.some((n) => n.question) ? 40 : 0;
  const totalHeight = nodeRowY + maxNodeH + QUESTION_BAND_H + PAD;

  // Emit zones FIRST so node + arrow z-order paints them last.
  // Zone bbox = [start node left, end node right] padded by 20px
  // horizontally; vertically spans the node row + label band above.
  const ZONE_PAD_X = 20;
  const ZONE_PAD_Y = 12;
  if (args.zones) {
    for (let i = 0; i < args.zones.length; i += 1) {
      const z = args.zones[i];
      const startX = xs[z.startIdx];
      const endX = xs[z.endIdx] + styles[z.endIdx].width;
      const zoneX = startX - ZONE_PAD_X;
      const zoneY = nodeRowY - ZONE_PAD_Y;
      const zoneW = (endX - startX) + 2 * ZONE_PAD_X;
      const zoneH = maxNodeH + 2 * ZONE_PAD_Y;
      elements.push({
        type: 'rectangle',
        id: `tpl-zone-${i}`,
        x: zoneX,
        y: zoneY,
        width: zoneW,
        height: zoneH,
        strokeColor: 'transparent',
        backgroundColor: zoneFillForRole(z.role),
        strokeWidth: 0,
        strokeStyle: 'solid',
        roundness: { type: 3 },
        roughness: 0,
        fillStyle: 'solid',
        boundElements: [],
        opacity: 30,
        customData: {
          fathomKind: 'wb-zone',
          role: z.role,
          purpose: 'template-zone',
        },
      } as unknown as SceneElement);
      // Zone label above the zone — small uppercase chip.
      const lbl = z.label.toUpperCase().slice(0, 24);
      elements.push({
        type: 'text',
        id: `tpl-zone-lbl-${i}`,
        x: zoneX + 8,
        y: zoneY - ZONE_LABEL_BAND_H + 4,
        width: Math.max(40, lbl.length * Math.ceil(TEMPLATE_CONSTANTS.charW(ZONE_LABEL_FONT)) + 8),
        height: ZONE_LABEL_BAND_H - 4,
        text: lbl,
        originalText: lbl,
        autoResize: false,
        fontSize: ZONE_LABEL_FONT,
        fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: '#5a4a3a',
        containerId: null,
        customData: { fathomKind: 'wb-zone-label' },
      } as SceneElement);
    }
  }

  // Emit nodes.
  const nodeIds: string[] = [];
  for (let i = 0; i < args.nodes.length; i += 1) {
    const n = args.nodes[i];
    const s = styles[i];
    const id = `tpl-node-${i}`;
    nodeIds.push(id);
    const labelText = n.label.length > 28 ? n.label.slice(0, 27) + '…' : n.label;
    elements.push({
      type: 'rectangle',
      id,
      x: xs[i],
      y: nodeRowY,
      width: s.width,
      height: s.height,
      strokeColor: s.stroke,
      backgroundColor: s.fill,
      strokeWidth: s.strokeWidth,
      strokeStyle: n.drillable ? 'dashed' : 'solid',
      roundness: { type: 3 },
      roughness: 1,
      fillStyle: 'solid',
      boundElements: [],
      // Use Excalidraw skeleton's `label` sugar so the renderer's
      // convertToExcalidrawElements expands this into a bound text
      // element auto-fitted to the rect.
      label: {
        text: labelText,
        fontSize: LABEL_FONT,
        fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
        textAlign: 'center',
        verticalAlign: 'middle',
      },
      customData: {
        fathomKind: 'wb-node',
        role: n.role,
        kind: n.role,
        drillable: n.drillable === true,
      },
    } as unknown as SceneElement);

    // Question subtitle BELOW the node, same as
    // create_node_with_fitted_text's wb-node-question.
    if (n.question) {
      const qRaw = n.question.trim();
      const qText = qRaw.startsWith('→') ? qRaw : `→ ${qRaw}`;
      const charBudget = Math.max(8, Math.floor(s.width / TEMPLATE_CONSTANTS.charW(SUMMARY_FONT)));
      const lines = wrapToCharLimit(qText, charBudget);
      const lineH = Math.ceil(SUMMARY_FONT * 1.4);
      elements.push({
        type: 'text',
        id: `tpl-node-q-${i}`,
        x: xs[i],
        y: nodeRowY + s.height + 8,
        width: s.width,
        height: lines.length * lineH + 4,
        text: lines.join('\n'),
        originalText: lines.join('\n'),
        autoResize: false,
        fontSize: SUMMARY_FONT,
        fontFamily: TEMPLATE_CONSTANTS.FONT_EXCALIFONT,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: '#5a4a3a',
        containerId: null,
        customData: { fathomKind: 'wb-node-question' },
      } as SceneElement);
    }
  }

  // Emit arrows.
  if (args.connections) {
    for (let i = 0; i < args.connections.length; i += 1) {
      const c = args.connections[i];
      const fromIdx = c.fromIdx;
      const toIdx = c.toIdx;
      const fromX = xs[fromIdx] + styles[fromIdx].width;
      const fromY = nodeRowY + styles[fromIdx].height / 2;
      const toX = xs[toIdx];
      const toY = nodeRowY + styles[toIdx].height / 2;
      const id = `tpl-arrow-${i}`;
      elements.push({
        type: 'arrow',
        id,
        x: fromX,
        y: fromY,
        points: [
          [0, 0],
          [toX - fromX, toY - fromY],
        ],
        strokeColor: '#1a1614',
        strokeWidth: 1.2,
        roughness: 1,
        startBinding: { elementId: nodeIds[fromIdx], focus: 0, gap: 1 },
        endBinding: { elementId: nodeIds[toIdx], focus: 0, gap: 1 },
        label: c.label
          ? {
              text: c.label.slice(0, 24),
              fontSize: ARROW_LABEL_FONT,
              fontFamily: TEMPLATE_CONSTANTS.FONT_HELVETICA,
              strokeColor: '#5a4a3a',
            }
          : undefined,
        customData: { fathomKind: 'wb-edge' },
      } as SceneElement);
    }
  }

  if (args.nodes.length > 6) {
    warnings.push(`flow-chart: ${args.nodes.length} nodes is dense; consider grouping into a parent block.`);
  }

  return {
    elements,
    bbox: { width: totalWidth, height: totalHeight },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const flowChartTemplate: TemplateDef<FlowChartArgs> = {
  id: 'flow-chart',
  name: 'Flow chart / pipeline',
  validate,
  layout,
};
