/**
 * Cross-cut exports usable by both `pipeline/` and `renderer/`. Keep
 * dependency-free — no Node `fs`, no React, no SDK.
 */

export {
  wrapToWidth,
  fitNodeSize,
  LINE_HEIGHT_RATIO,
} from './whiteboard-text-fit';

export {
  ROLES,
  KINDS,
  rolePalette,
  defaultRoleForKind,
} from './whiteboard-palette';
export type { Role, Kind } from './whiteboard-palette';

export type {
  PaperIndex,
  PipelineArtifact,
  OnArtifactCallback,
} from './types';
