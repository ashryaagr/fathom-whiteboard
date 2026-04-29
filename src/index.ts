// Pipeline (Node-side, used in main process / scripts)
export { generateWhiteboard, refineWhiteboard, HOSTED_EXCALIDRAW_MCP_URL } from './pipeline.js';
export { resolveHosted, spawnLocalMcp } from './mcp-launcher.js';
export { COLEAM_SKILL } from './skill.js';

// Renderer (React, used in renderer process)
export { Whiteboard } from './Whiteboard.js';
export type { WhiteboardHost } from './Whiteboard.js';

// Shared types
export type {
  ExcalidrawElement,
  WhiteboardScene,
  GenerateCallbacks,
  PaperRef,
  McpConfig,
} from './types.js';
