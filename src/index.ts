// Pipeline (Node-side, used in main process / scripts)
//
// IMPORTANT: do NOT import the renderer entry from this file or any
// transitive dependency. The renderer (`./react`) lives in a separate
// entry point so bundlers building a browser bundle (Vite renderer
// process) can import it without dragging the Claude Agent SDK
// (Node-only) into the browser bundle.
export { generateWhiteboard, refineWhiteboard, HOSTED_EXCALIDRAW_MCP_URL } from './pipeline.js';
export { resolveHosted, spawnLocalMcp } from './mcp-launcher.js';
export { COLEAM_SKILL } from './skill.js';

// Shared types — safe to re-export from both entries.
export type {
  ExcalidrawElement,
  WhiteboardScene,
  GenerateCallbacks,
  PaperRef,
  McpConfig,
} from './types.js';
