import { contextBridge, ipcRenderer } from 'electron';

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

type Viewport = { scrollX: number; scrollY: number; zoom: number };

const wbApi = {
  paper: {
    load: (): Promise<PaperPayload | null> => ipcRenderer.invoke('paper:load'),
    save: (p: PaperPayload): Promise<void> => ipcRenderer.invoke('paper:save', p),
    clear: (): Promise<void> => ipcRenderer.invoke('paper:clear'),
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
    req: { paper: PaperPayload; focus?: string },
    cb: {
      onLog?: (text: string) => void;
      onScene?: (elements: unknown[]) => void;
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
  refine: (
    req: { paper: PaperPayload; scene: { elements: unknown[] }; instruction: string },
    cb: {
      onLog?: (text: string) => void;
      onScene?: (elements: unknown[]) => void;
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
};

contextBridge.exposeInMainWorld('wb', wbApi);

export type WbApi = typeof wbApi;
