// Renderer entry — safe to import in browser/Electron-renderer bundles.
// Excludes everything that depends on Node built-ins (the Agent SDK,
// the MCP launcher, the SKILL constant). Hosts that need both can
// import the renderer from `fathom-whiteboard/react` and the pipeline
// from `fathom-whiteboard` separately.

export { Whiteboard } from './Whiteboard.js';
export type { WhiteboardHost } from './Whiteboard.js';

export type {
  ExcalidrawElement,
  WhiteboardScene,
  GenerateCallbacks,
  PaperRef,
  McpConfig,
} from './types.js';
