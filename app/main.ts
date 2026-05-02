// Standalone Electron app for fathom-whiteboard.
//
// Same component the PDF reader imports, hosted in a minimal shell so
// the whiteboard works as a brainstorming surface against any pasted
// content (text, image, PDF). Persistence + AI generation live in this
// main process; the renderer is just <Whiteboard> with a paste-aware
// landing screen on top.

import { app, BrowserWindow, Menu, ipcMain, type IpcMainInvokeEvent } from 'electron';
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

// Per-window session isolation. Each BrowserWindow has its own
// session id stored in `windowSessions` and its own work dir under
// `sessions/<sessionId>`. The first window on app launch reuses
// "last" so closing + reopening restores the previous whiteboard
// (mirrors the PDF reader's behaviour). Cmd+N spawns a new window
// with a fresh uuid session so windows don't clobber each other.
const FIRST_SESSION_ID = 'last';
const windowSessions = new Map<number, string>();

function newSessionId(): string {
  return randomBytes(8).toString('hex');
}

function sessionFor(event?: IpcMainInvokeEvent): string {
  if (!event) return FIRST_SESSION_ID;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return FIRST_SESSION_ID;
  return windowSessions.get(win.id) ?? FIRST_SESSION_ID;
}

function workDir(event?: IpcMainInvokeEvent): string {
  const root = app.getPath('userData');
  return join(root, 'sessions', sessionFor(event));
}

const SCENE_FILE = 'whiteboard.excalidraw';
const VIEWPORT_FILE = 'whiteboard.viewport.json';
const PAPER_FILE = 'paper.json';
const ASSETS_DIR = 'assets';

type PaperPayload =
  | { kind: 'text'; markdown: string; title?: string }
  | { kind: 'path'; absPath: string; title?: string };

async function ensureWorkDir(event?: IpcMainInvokeEvent): Promise<string> {
  const dir = workDir(event);
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });
  return dir;
}

async function loadPaper(event?: IpcMainInvokeEvent): Promise<PaperPayload | null> {
  const f = join(workDir(event), PAPER_FILE);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(await readFile(f, 'utf-8')) as PaperPayload;
  } catch {
    return null;
  }
}

async function savePaper(event: IpcMainInvokeEvent, p: PaperPayload): Promise<void> {
  const dir = await ensureWorkDir(event);
  await writeFile(join(dir, PAPER_FILE), JSON.stringify(p), 'utf-8');
}

async function loadScene(event?: IpcMainInvokeEvent): Promise<WhiteboardScene | null> {
  const f = join(workDir(event), SCENE_FILE);
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

async function saveScene(event: IpcMainInvokeEvent | undefined, scene: WhiteboardScene): Promise<void> {
  const dir = await ensureWorkDir(event);
  const wrapped = {
    type: 'excalidraw',
    version: 2,
    source: 'fathom-whiteboard-app',
    elements: scene.elements,
    appState: { viewBackgroundColor: '#ffffff' },
  };
  await writeFile(join(dir, SCENE_FILE), JSON.stringify(wrapped, null, 2), 'utf-8');
}

async function loadViewport(event?: IpcMainInvokeEvent): Promise<{
  scrollX: number;
  scrollY: number;
  zoom: number;
} | null> {
  const f = join(workDir(event), VIEWPORT_FILE);
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

async function saveViewport(event: IpcMainInvokeEvent, vp: {
  scrollX: number;
  scrollY: number;
  zoom: number;
}): Promise<void> {
  const dir = await ensureWorkDir(event);
  await writeFile(join(dir, VIEWPORT_FILE), JSON.stringify(vp), 'utf-8');
}

async function clearSession(event: IpcMainInvokeEvent): Promise<void> {
  const dir = workDir(event);
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

// Move the calling window's session snapshot into a timestamped
// archive dir so the user can come back to it later, then clear the
// session. Used by the "Save & New" path on the top-bar New button —
// the user keeps a recoverable copy of the whiteboard they just left
// rather than losing the API spend they paid to generate it.
async function archiveSession(event: IpcMainInvokeEvent): Promise<{ archivedAt: string | null }> {
  const root = app.getPath('userData');
  const sid = sessionFor(event);
  const src = join(root, 'sessions', sid);
  const hasContent =
    existsSync(join(src, PAPER_FILE)) ||
    existsSync(join(src, SCENE_FILE));
  if (!hasContent) return { archivedAt: null };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(root, 'sessions', `archive-${ts}`);
  await mkdir(archiveDir, { recursive: true });
  for (const f of [SCENE_FILE, VIEWPORT_FILE, PAPER_FILE]) {
    const sf = join(src, f);
    if (!existsSync(sf)) continue;
    try {
      const data = await readFile(sf);
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

async function saveAsset(event: IpcMainInvokeEvent, args: {
  filename: string;
  bytes: ArrayBufferLike;
}): Promise<{ absPath: string }> {
  const dir = await ensureWorkDir(event);
  const id = randomBytes(4).toString('hex');
  const safe = safeAssetName(args.filename);
  const absPath = join(dir, ASSETS_DIR, `${id}-${safe}`);
  await writeFile(absPath, Buffer.from(args.bytes));
  return { absPath };
}

// ---------- IPC ----------

ipcMain.handle('paper:load', async (e) => loadPaper(e));
ipcMain.handle('paper:save', async (e, payload: PaperPayload) => {
  await savePaper(e, payload);
});
ipcMain.handle('paper:clear', async (e) => clearSession(e));
ipcMain.handle('session:archive', async (e) => archiveSession(e));
ipcMain.handle('asset:save', async (e, args: { filename: string; bytes: ArrayBuffer }) =>
  saveAsset(e, args),
);

ipcMain.handle('scene:load', async (e) => loadScene(e));
ipcMain.handle('scene:save', async (e, scene: WhiteboardScene) => saveScene(e, scene));
ipcMain.handle('viewport:load', async (e) => loadViewport(e));
ipcMain.handle('viewport:save', async (e, vp: {
  scrollX: number;
  scrollY: number;
  zoom: number;
}) => saveViewport(e, vp));

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
    await saveScene(event, scene);
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
    await savePaper(event, req.paper);
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
        await saveScene(event, scene);
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

async function createWindow(sessionId: string = FIRST_SESSION_ID): Promise<void> {
  // Make sure the session dir exists before the renderer's first IPC
  // call lands. Each window has its own session, so this runs per-call.
  const root = app.getPath('userData');
  await mkdir(join(root, 'sessions', sessionId, ASSETS_DIR), { recursive: true });
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
  windowSessions.set(win.id, sessionId);
  win.on('closed', () => windowSessions.delete(win.id));

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

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'clawdSlate',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          // Cmd+N spawns a fresh whiteboard window with its own session
          // dir under sessions/<uuid>. The first window on app launch
          // owns sessions/last so closing + reopening restores the
          // previous whiteboard; new windows are scratchpads.
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            void createWindow(newSessionId());
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildAppMenu();
  await createWindow(FIRST_SESSION_ID);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow(FIRST_SESSION_ID);
});
