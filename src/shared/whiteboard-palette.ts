/**
 * Role-aware palette + kind→role mapping. Lifted from
 * `whiteboard-mcp.ts` per Dedup B (#71).
 *
 * Two surfaces:
 *
 *   1. `Role` — the v3.2.1 critic-rubric semantic role of a node
 *      (input / output / process / math / noise / neutral). Drives
 *      6-color fills + strokes + zone tints.
 *
 *   2. `Kind` — the authoring-time taxonomy on a `WBNode`
 *      (input / process / output / data / model). Used for the
 *      simpler 3-output `paletteFor` (NOT lifted here per #71 scope —
 *      both copies are byte-for-byte identical and consolidating
 *      would be cosmetic). `defaultRoleForKind` maps Kind → Role
 *      when the agent doesn't pass `role` explicitly, keeping
 *      back-compat with pre-rubric call sites.
 *
 * Color values are unchanged from MCP's authoritative version.
 */

export const ROLES = ['input', 'output', 'process', 'math', 'noise', 'neutral'] as const;
export type Role = (typeof ROLES)[number];

export const KINDS = ['input', 'process', 'output', 'data', 'model'] as const;
export type Kind = (typeof KINDS)[number];

/** Returns the fill / stroke / zone-tint a node with the given Role
 * should render with. Color carries semantic load — every shape's fill
 * asserts a role per the v3.2.1 critic rubric:
 *   blue   = input / source
 *   green  = success / output
 *   amber  = notes / decisions / math
 *   red    = error / critical / noise
 *   purple = processing / special
 * `kind: 'model'` continues to override stroke (warm amber) at the
 * caller — this function returns role-only colors. */
export function rolePalette(role: Role): { fill: string; stroke: string; zoneFill: string } {
  switch (role) {
    case 'input':
      return { fill: '#a5d8ff', stroke: '#4a9eed', zoneFill: '#dbe4ff' };
    case 'output':
      return { fill: '#b2f2bb', stroke: '#22c55e', zoneFill: '#d3f9d8' };
    case 'process':
      return { fill: '#d0bfff', stroke: '#8b5cf6', zoneFill: '#e9defc' };
    case 'math':
      return { fill: '#fff3bf', stroke: '#f59e0b', zoneFill: '#fff9db' };
    case 'noise':
      return { fill: '#ffc9c9', stroke: '#ef4444', zoneFill: '#ffe3e3' };
    case 'neutral':
    default:
      return { fill: '#fcfaf5', stroke: '#5a4a3a', zoneFill: '#f4efe8' };
  }
}

/** Default Role inferred from Kind when the agent doesn't pass `role`
 * explicitly. Keeps back-compat with pre-rubric call sites. */
export function defaultRoleForKind(kind: Kind): Role {
  switch (kind) {
    case 'input':
      return 'input';
    case 'output':
      return 'output';
    case 'data':
      return 'neutral';
    case 'model':
    case 'process':
    default:
      return 'process';
  }
}
