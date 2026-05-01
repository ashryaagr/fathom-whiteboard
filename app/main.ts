// Standalone Electron app for fathom-whiteboard.
//
// Same component the PDF reader imports, hosted in a minimal shell so
// the whiteboard works as a brainstorming surface against any pasted
// content (text, image, PDF). Persistence + AI generation live in this
// main process; the renderer is just <Whiteboard> with a paste-aware
// landing screen on top.

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  generateWhiteboard,
  refineWhiteboard,
  type PaperRef,
  type WhiteboardScene,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Resolve the bundled `claude` binary to its on-disk unpacked path so
// child_process.spawn() doesn't trip over the asar virtual filesystem.
//
// The Claude Agent SDK computes its bundled binary path from
// `import.meta.url`. Inside a packaged Electron app that path lives at
// `…/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`.
// asar's hook lets `Read` see through the archive, but `spawn` goes
// straight to the real filesystem and sees `app.asar` as a FILE →
// ENOTDIR. electron-builder unpacks the platform package via
// `asarUnpack`, so the binary is on disk under
// `…/Resources/app.asar.unpacked/node_modules/…/claude`. We pre-resolve
// to that path and pass it to generateWhiteboard / refineWhiteboard
// via `pathToClaudeCodeExecutable`.
function resolveClaudeExecutablePath(): string | undefined {
  const platformPkg =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'claude-agent-sdk-darwin-arm64'
      : process.platform === 'darwin'
        ? 'claude-agent-sdk-darwin-x64'
        : process.platform === 'win32' && process.arch === 'x64'
          ? 'claude-agent-sdk-win32-x64'
          : null;
  if (!platformPkg) return undefined;

  const candidates = app.isPackaged
    ? [
        join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          '@anthropic-ai',
          platformPkg,
          'claude',
        ),
      ]
    : [
        join(
          app.getAppPath(),
          'node_modules',
          '@anthropic-ai',
          platformPkg,
          'claude',
        ),
      ];
  // Common user-installed fallbacks if the bundled binary is missing
  // (someone deleted it, dev runs without the native package, etc.).
  const home = process.env.HOME ?? '';
  const userFallbacks = home
    ? [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'bin', 'claude'),
      ]
    : [];
  for (const p of [...candidates, ...userFallbacks]) {
    if (existsSync(p) && !p.includes('app.asar/')) return p;
  }
  return undefined;
}

// Per-session work dir holds pasted assets (images, PDFs) keyed by
// session id, plus the persisted scene + viewport. We use a stable
// "last session" dir so closing + reopening the app restores the
// last whiteboard, mirroring the PDF reader's behaviour.
function workDir(): string {
  const root = app.getPath('userData');
  return join(root, 'sessions', 'last');
}

const SCENE_FILE = 'whiteboard.excalidraw';
const VIEWPORT_FILE = 'whiteboard.viewport.json';
const PAPER_FILE = 'paper.json';
const ASSETS_DIR = 'assets';

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

async function ensureWorkDir(): Promise<string> {
  const dir = workDir();
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });
  return dir;
}

async function loadPaper(): Promise<PaperPayload | null> {
  const f = join(workDir(), PAPER_FILE);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(await readFile(f, 'utf-8')) as PaperPayload;
  } catch {
    return null;
  }
}

async function savePaper(p: PaperPayload): Promise<void> {
  const dir = await ensureWorkDir();
  await writeFile(join(dir, PAPER_FILE), JSON.stringify(p), 'utf-8');
}

async function loadScene(): Promise<WhiteboardScene | null> {
  const f = join(workDir(), SCENE_FILE);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(await readFile(f, 'utf-8')) as {
      elements?: unknown[];
    };
    if (!Array.isArray(raw.elements)) return null;
    return { elements: raw.elements as WhiteboardScene['elements'] };
  } catch {
    return null;
  }
}

async function saveScene(scene: WhiteboardScene): Promise<void> {
  const dir = await ensureWorkDir();
  const wrapped = {
    type: 'excalidraw',
    version: 2,
    source: 'fathom-whiteboard-app',
    elements: scene.elements,
    appState: { viewBackgroundColor: '#ffffff' },
  };
  await writeFile(join(dir, SCENE_FILE), JSON.stringify(wrapped, null, 2), 'utf-8');
}

async function loadViewport(): Promise<{
  scrollX: number;
  scrollY: number;
  zoom: number;
} | null> {
  const f = join(workDir(), VIEWPORT_FILE);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(await readFile(f, 'utf-8')) as Partial<{
      scrollX: number;
      scrollY: number;
      zoom: number;
    }>;
    if (
      typeof raw.scrollX === 'number' &&
      typeof raw.scrollY === 'number' &&
      typeof raw.zoom === 'number'
    ) {
      return { scrollX: raw.scrollX, scrollY: raw.scrollY, zoom: raw.zoom };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveViewport(vp: {
  scrollX: number;
  scrollY: number;
  zoom: number;
}): Promise<void> {
  const dir = await ensureWorkDir();
  await writeFile(join(dir, VIEWPORT_FILE), JSON.stringify(vp), 'utf-8');
}

async function clearSession(): Promise<void> {
  const dir = workDir();
  for (const f of [SCENE_FILE, VIEWPORT_FILE, PAPER_FILE]) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try {
        await writeFile(p, '');
      } catch {
        /* ignore */
      }
    }
  }
}

// Move the current `sessions/last/` snapshot into a timestamped
// archive dir so the user can come back to it later, then clear `last`.
// Used by the "Save & New" path on the top-bar New button — the user
// keeps a recoverable copy of the whiteboard they just left rather than
// losing the API spend they paid to generate it.
async function archiveSession(): Promise<{ archivedAt: string | null }> {
  const root = app.getPath('userData');
  const last = join(root, 'sessions', 'last');
  const hasContent =
    existsSync(join(last, PAPER_FILE)) ||
    existsSync(join(last, SCENE_FILE));
  if (!hasContent) return { archivedAt: null };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(root, 'sessions', `archive-${ts}`);
  await mkdir(archiveDir, { recursive: true });
  for (const f of [SCENE_FILE, VIEWPORT_FILE, PAPER_FILE]) {
    const src = join(last, f);
    if (!existsSync(src)) continue;
    try {
      const data = await readFile(src);
      await writeFile(join(archiveDir, f), data);
    } catch {
      /* best-effort copy; missing or unreadable file is fine */
    }
  }
  return { archivedAt: archiveDir };
}

// Convert pasted content into a PaperRef the pipeline can consume.
// Text is the primary path; images become markdown image references
// in a synthetic paper; PDFs are saved as files and the agent reads
// them via the Read tool.
function buildPaperRef(payload: PaperPayload): PaperRef {
  if (payload.kind === 'text') {
    return { kind: 'text', markdown: payload.markdown, title: payload.title ?? 'Brainstorm' };
  }
  return { kind: 'path', absPath: payload.absPath, title: payload.title ?? 'Brainstorm' };
}

function safeAssetName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80);
  return cleaned.length > 0 ? cleaned : 'asset';
}

async function saveAsset(args: {
  filename: string;
  bytes: ArrayBufferLike;
}): Promise<{ absPath: string }> {
  const dir = await ensureWorkDir();
  const id = randomBytes(4).toString('hex');
  const safe = safeAssetName(args.filename);
  const absPath = join(dir, ASSETS_DIR, `${id}-${safe}`);
  await writeFile(absPath, Buffer.from(args.bytes));
  return { absPath };
}

// ---------- IPC ----------

ipcMain.handle('paper:load', async () => loadPaper());
ipcMain.handle('paper:save', async (_e, payload: PaperPayload) => {
  await savePaper(payload);
});
ipcMain.handle('paper:clear', async () => clearSession());
ipcMain.handle('session:archive', async () => archiveSession());
ipcMain.handle('asset:save', async (_e, args: { filename: string; bytes: ArrayBuffer }) =>
  saveAsset(args),
);

ipcMain.handle('scene:load', async () => loadScene());
ipcMain.handle('scene:save', async (_e, scene: WhiteboardScene) => saveScene(scene));
ipcMain.handle('viewport:load', async () => loadViewport());
ipcMain.handle('viewport:save', async (_e, vp: {
  scrollX: number;
  scrollY: number;
  zoom: number;
}) => saveViewport(vp));

const activeRuns = new Map<string, AbortController>();

async function runStreamingGenerate(
  event: IpcMainInvokeEvent,
  channel: string,
  paper: PaperRef,
  focus: string | undefined,
  abortController: AbortController,
) {
  const sender = event.sender;
  try {
    const { scene, usd, turns } = await generateWhiteboard(
      paper,
      {
        onLog: (line) => {
          if (!sender.isDestroyed()) sender.send(channel, { type: 'log', text: line });
        },
        onAssistantText: (delta) => {
          if (!sender.isDestroyed()) sender.send(channel, { type: 'delta', text: delta });
        },
        onSceneUpdate: (s) => {
          if (!sender.isDestroyed())
            sender.send(channel, { type: 'scene', elements: s.elements });
        },
      },
      undefined,
      focus,
      resolveClaudeExecutablePath(),
      abortController,
    );
    if (!sender.isDestroyed())
      sender.send(channel, {
        type: 'done',
        elements: scene.elements,
        usd,
        turns,
      });
    await saveScene(scene);
  } catch (err) {
    if (!sender.isDestroyed())
      sender.send(channel, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
  }
}

ipcMain.handle(
  'generate:start',
  async (
    event,
    req: { paper: PaperPayload; focus?: string },
  ): Promise<{ channel: string }> => {
    await savePaper(req.paper);
    const channel = `generate:event:${randomBytes(4).toString('hex')}`;
    const ctrl = new AbortController();
    activeRuns.set(channel, ctrl);
    void runStreamingGenerate(
      event,
      channel,
      buildPaperRef(req.paper),
      req.focus,
      ctrl,
    ).finally(() => activeRuns.delete(channel));
    return { channel };
  },
);

ipcMain.handle(
  'refine:start',
  async (
    event,
    req: { paper: PaperPayload; scene: WhiteboardScene; instruction: string },
  ): Promise<{ channel: string }> => {
    const channel = `refine:event:${randomBytes(4).toString('hex')}`;
    const ctrl = new AbortController();
    activeRuns.set(channel, ctrl);
    const paperRef = buildPaperRef(req.paper);
    void (async () => {
      const sender = event.sender;
      try {
        const { scene } = await refineWhiteboard(
          req.scene,
          paperRef,
          req.instruction,
          {
            onLog: (line) => {
              if (!sender.isDestroyed()) sender.send(channel, { type: 'log', text: line });
            },
            onAssistantText: (delta) => {
              if (!sender.isDestroyed())
                sender.send(channel, { type: 'delta', text: delta });
            },
            onSceneUpdate: (s) => {
              if (!sender.isDestroyed())
                sender.send(channel, { type: 'scene', elements: s.elements });
            },
          },
          undefined,
          resolveClaudeExecutablePath(),
          ctrl,
        );
        if (!sender.isDestroyed())
          sender.send(channel, { type: 'done', elements: scene.elements });
        await saveScene(scene);
      } catch (err) {
        if (!sender.isDestroyed())
          sender.send(channel, {
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
      } finally {
        activeRuns.delete(channel);
      }
    })();
    return { channel };
  },
);

// Abort an in-flight generate/refine run by channel id. Pipeline
// catches the resulting AbortError and emits `[aborted]`; the host's
// finally clause in runStreamingGenerate / refine handler still runs
// and the channel gets cleaned up.
ipcMain.handle('generate:abort', async (_e, channel: string) => {
  const ctrl = activeRuns.get(channel);
  if (ctrl && !ctrl.signal.aborted) ctrl.abort();
});

// ---------- Window ----------

async function createWindow(): Promise<void> {
  await ensureWorkDir();
  // Set the dock icon during `npm run app` (dev) so the running app
  // doesn't show a generic Electron icon. When packaged via
  // electron-builder, build config is responsible for the .icns; this
  // hook only matters for the dev path. The 1024x1024 PNG sits at the
  // package root next to icon.icns.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = resolve(__dirname, '..', 'icon-1024.png');
    if (existsSync(iconPath)) {
      try {
        app.dock.setIcon(iconPath);
      } catch {
        /* dock not ready or platform mismatch — non-fatal */
      }
    }
  }
  app.setName('clawdSlate');
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    title: 'clawdSlate',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Forward renderer console to main-process stderr so a tail on the
  // log file gives a single feed of both worlds. Cheap to leave on
  // during dev/test; off-by-default in shipped builds via the env flag.
  if (process.env.WB_DEVTOOLS === '1' || process.env.WB_FORWARD_CONSOLE === '1') {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['v', 'i', 'w', 'e'][level] ?? '?';
      const where = sourceId ? `${sourceId.split('/').pop()}:${line}` : '';
      process.stderr.write(`[renderer ${tag}] ${message} ${where}\n`);
    });
  }

  if (isDev && process.env.WB_DEV_URL) {
    await win.loadURL(process.env.WB_DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // After app/build.mjs runs, both main.js and renderer/index.html
    // sit under app/dist/. main.js is __dirname; the html is one level
    // down in renderer/.
    const indexHtml = resolve(__dirname, 'renderer', 'index.html');
    await win.loadURL(pathToFileURL(indexHtml).toString());
    if (process.env.WB_DEVTOOLS === '1')
      win.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
