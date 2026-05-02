import { contextBridge, ipcRenderer } from 'electron';

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

type Viewport = { scrollX: number; scrollY: number; zoom: number };

// Tool toggles surfaced by the renderer's settings popover. All
// fields optional; main applies sane defaults (webSearch on, arxiv
// on). `disallowed` is an exact-name list of tools the user has
// turned off via per-MCP-server toggles.
type ToolSettings = {
  webSearch?: boolean;
  arxiv?: boolean;
  disallowed?: string[];
};

const wbApi = {
  paper: {
    load: (): Promise<PaperPayload | null> => ipcRenderer.invoke('paper:load'),
    save: (p: PaperPayload): Promise<void> => ipcRenderer.invoke('paper:save', p),
    clear: (): Promise<void> => ipcRenderer.invoke('paper:clear'),
  },
  session: {
    archive: (): Promise<{ archivedAt: string | null }> =>
      ipcRenderer.invoke('session:archive'),
  },
  asset: {
    save: (filename: string, bytes: ArrayBuffer): Promise<{ absPath: string }> =>
      ipcRenderer.invoke('asset:save', { filename, bytes }),
  },
  scene: {
    load: (): Promise<{ elements: unknown[] } | null> => ipcRenderer.invoke('scene:load'),
    save: (scene: { elements: unknown[] }): Promise<void> =>
      ipcRenderer.invoke('scene:save', scene),
  },
  viewport: {
    load: (): Promise<Viewport | null> => ipcRenderer.invoke('viewport:load'),
    save: (vp: Viewport): Promise<void> => ipcRenderer.invoke('viewport:save', vp),
  },
  generate: (
    req: { paper: PaperPayload; focus?: string; tools?: ToolSettings },
    cb: {
      onLog?: (text: string) => void;
      onScene?: (elements: unknown[]) => void;
      onAvailableTools?: (tools: string[]) => void;
      onDone?: (info: { elements: unknown[]; usd: number; turns: number }) => void;
      onError?: (message: string) => void;
    },
  ): Promise<{ channel: string }> =>
    (async () => {
      const { channel } = (await ipcRenderer.invoke('generate:start', req)) as {
        channel: string;
      };
      const handler = (_e: Electron.IpcRendererEvent, msg: Record<string, unknown>) => {
        if (msg.type === 'log') cb.onLog?.(String(msg.text ?? ''));
        else if (msg.type === 'scene') cb.onScene?.(msg.elements as unknown[]);
        else if (msg.type === 'available-tools')
          cb.onAvailableTools?.((msg.tools as string[]) ?? []);
        else if (msg.type === 'done')
          cb.onDone?.(
            msg as unknown as { elements: unknown[]; usd: number; turns: number },
          );
        else if (msg.type === 'error') cb.onError?.(String(msg.message ?? ''));
        if (msg.type === 'done' || msg.type === 'error') {
          ipcRenderer.removeListener(channel, handler);
        }
      };
      ipcRenderer.on(channel, handler);
      return { channel };
    })(),

  // Read the most recently captured tool list (from the last agent
  // run). Empty array on first launch before any run has happened.
  getAvailableTools: (): Promise<string[]> =>
    ipcRenderer.invoke('tools:available:get'),
  refine: (
    req: {
      paper: PaperPayload;
      scene: { elements: unknown[] };
      instruction: string;
      tools?: ToolSettings;
    },
    cb: {
      onLog?: (text: string) => void;
      onScene?: (elements: unknown[]) => void;
      onAvailableTools?: (tools: string[]) => void;
      onDone?: (info: { elements: unknown[] }) => void;
      onError?: (message: string) => void;
    },
  ): Promise<{ channel: string }> =>
    (async () => {
      const { channel } = (await ipcRenderer.invoke('refine:start', req)) as {
        channel: string;
      };
      const handler = (_e: Electron.IpcRendererEvent, msg: Record<string, unknown>) => {
        if (msg.type === 'log') cb.onLog?.(String(msg.text ?? ''));
        else if (msg.type === 'scene') cb.onScene?.(msg.elements as unknown[]);
        else if (msg.type === 'available-tools')
          cb.onAvailableTools?.((msg.tools as string[]) ?? []);
        else if (msg.type === 'done')
          cb.onDone?.(msg as unknown as { elements: unknown[] });
        else if (msg.type === 'error') cb.onError?.(String(msg.message ?? ''));
        if (msg.type === 'done' || msg.type === 'error') {
          ipcRenderer.removeListener(channel, handler);
        }
      };
      ipcRenderer.on(channel, handler);
      return { channel };
    })(),
  // Abort an in-flight generate/refine run. Main listens on
  // `generate:abort` and signals the per-run AbortController, which
  // propagates into the SDK's query() and unwinds the for-await loop
  // with an AbortError. The pipeline catches it and emits
  // `[aborted]` instead of surfacing as a user-visible error.
  abort: (channel: string): Promise<void> =>
    ipcRenderer.invoke('generate:abort', channel),

  // Renderer error reporter — main writes the entry to clawdSlate.log
  // under userData. Fire-and-forget; never blocks the renderer.
  reportError: (scope: string, message: string, stack: string): void => {
    void ipcRenderer.invoke('renderer:report-error', { scope, message, stack });
  },
};

contextBridge.exposeInMainWorld('wb', wbApi);

export type WbApi = typeof wbApi;
