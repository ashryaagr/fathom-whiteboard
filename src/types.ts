// Types shared between pipeline and renderer.

// One Excalidraw element (rect, ellipse, line, arrow, text, etc.).
// We keep it as a permissive object to track upstream Excalidraw schema changes
// without dragging the whole @excalidraw/excalidraw type surface into pipeline.
export type ExcalidrawElement = Record<string, unknown> & {
  id?: string;
  type?: string;
};

// A whiteboard scene = the flat list of elements we hand to Excalidraw.
// We persist this verbatim; the editor consumes it via initialData.elements.
export type WhiteboardScene = {
  elements: ExcalidrawElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

// Per-call streaming callbacks. The pipeline emits these as the agent works
// so the host can show progress, log to disk, etc.
export type GenerateCallbacks = {
  onLog?: (line: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onSceneUpdate?: (scene: WhiteboardScene) => void;
  onAssistantText?: (delta: string) => void;
  onDone?: (result: { scene: WhiteboardScene; turns: number; usd: number }) => void;
  onError?: (err: Error) => void;
};

// Reference to the paper being explained. Pass either the markdown text directly
// (recommended; cheap and Claude reads natively) or a path the agent can Read.
export type PaperRef =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

// MCP server configuration. By default we point at the hosted endpoint, which
// matches the control experiment that produced the design we're aligning to.
// `local` is reserved for spawning vendor/excalidraw-mcp once that build path
// is wired up; for now `hosted` is the supported route.
export type McpConfig =
  | { kind: 'hosted'; url?: string }
  | { kind: 'local'; spawn?: () => Promise<{ url: string; dispose: () => Promise<void> }> };
