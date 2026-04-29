import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve excalidraw-mcp.
//
// Default behaviour (and the path the user explicitly asked for): spawn
// a local copy of excalidraw-mcp on an OS-assigned port. Each call gets
// its own subprocess so multiple concurrent Fathom windows can author
// whiteboards in parallel without sharing scene state.
//
// The vendor directory is bootstrapped by `scripts/build-vendor.mjs`
// which runs as a postinstall hook (see package.json). It clones
// excalidraw/excalidraw-mcp into vendor/, patches main.ts so PORT=0
// prints the actual listening port, and builds dist/index.js. If the
// build hasn't run (no internet during install, missing toolchain),
// `spawnLocalMcp` throws a clear error and the consumer can fall back
// to `resolveHosted()`.
//
// Hosted endpoint (`https://mcp.excalidraw.com/mcp`) remains as an
// opt-in escape hatch via `resolveHosted()`. Use it when you need
// network-only access (e.g. testing without a build toolchain) or for
// debugging via the hosted maintainers.

export const HOSTED_EXCALIDRAW_MCP_URL = 'https://mcp.excalidraw.com/mcp';

export type McpHandle = {
  url: string;
  dispose: () => Promise<void>;
};

export async function resolveHosted(): Promise<McpHandle> {
  return {
    url: HOSTED_EXCALIDRAW_MCP_URL,
    dispose: async () => {},
  };
}

// Locate the bundled vendor entry point. Walks up from the launcher
// module looking for `vendor/excalidraw-mcp/dist/index.js`. The vendor
// directory is created by `scripts/build-vendor.mjs` either at the
// package root (npm install fathom-whiteboard) or in the source repo
// during development.
function findVendorEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/mcp-launcher.js → ../vendor/...
    resolve(here, '..', 'vendor', 'excalidraw-mcp', 'dist', 'index.js'),
    // src/mcp-launcher.ts during dev → ../vendor/...
    resolve(here, '..', '..', 'vendor', 'excalidraw-mcp', 'dist', 'index.js'),
  ];
  return candidates.find(existsSync) ?? null;
}

// In an Electron app.asar bundle, files referenced via `app.asar/...`
// paths can be read through Electron's fs hook but CANNOT be executed
// by Node's `child_process.spawn` (the child process sees the real
// disk, not the asar virtual filesystem). When `asarUnpack` puts the
// vendor on real disk under `app.asar.unpacked/...`, swap the path
// before spawning so the child has a real file to execute.
function spawnPathFor(distPath: string): string {
  const ASAR_TOKEN = '/app.asar/';
  const idx = distPath.indexOf(ASAR_TOKEN);
  if (idx < 0) return distPath;
  return (
    distPath.slice(0, idx) +
    '/app.asar.unpacked/' +
    distPath.slice(idx + ASAR_TOKEN.length)
  );
}

export async function spawnLocalMcp(): Promise<McpHandle> {
  const distPath = findVendorEntry();
  if (!distPath) {
    throw new Error(
      'fathom-whiteboard: vendor excalidraw-mcp is not built. ' +
        'Run `node scripts/build-vendor.mjs` from the fathom-whiteboard ' +
        'package root, or pass an `mcpOverride` with `kind:"hosted"` to ' +
        'use https://mcp.excalidraw.com/mcp instead.',
    );
  }
  const spawnTarget = spawnPathFor(distPath);

  // CRITICAL: when this code runs inside an Electron main process,
  // process.execPath points at the Electron binary, not Node. Spawning
  // Electron with a script argument launches it as a fresh Electron
  // app (which then waits for app.whenReady, never prints "listening
  // on", and times us out). ELECTRON_RUN_AS_NODE=1 makes Electron
  // behave as a plain Node interpreter for that subprocess. Outside
  // Electron the env var is ignored.
  //
  // We force cwd to the unpacked vendor dir's parent. If the parent
  // process's cwd happens to be inside `app.asar` (Electron's asar
  // hook makes the path *appear* to be a directory but spawn() goes
  // through the real filesystem and sees it as a file → ENOTDIR),
  // we must hand spawn a real directory.
  const safeCwd = dirname(spawnTarget);
  let proc;
  try {
    proc = spawn(process.execPath, [spawnTarget], {
      cwd: safeCwd,
      env: { ...process.env, PORT: '0', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as Error & { code?: string; path?: string };
    throw new Error(
      `spawn threw synchronously: ${e.message} (code=${e.code ?? '?'}, path=${e.path ?? '?'}). ` +
        `execPath=${process.execPath} spawnTarget=${spawnTarget} cwd=${safeCwd}`,
    );
  }

  // Surface ENOENT/ENOTDIR etc. immediately — without this the child's
  // spawn failure surfaces only via the 10s timeout which is misleading.
  let spawnErr: Error | null = null;
  proc.on('error', (err) => {
    spawnErr = err;
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const url = await new Promise<string>((res, rej) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        const detail = spawnErr
          ? ` spawnError: ${spawnErr.message} (code=${(spawnErr as NodeJS.ErrnoException).code ?? '?'}, path=${(spawnErr as NodeJS.ErrnoException).path ?? '?'});`
          : '';
        rej(
          new Error(
            `excalidraw-mcp did not print listening URL within 10s.${detail} ` +
              `execPath=${process.execPath} ` +
              `spawnTarget=${spawnTarget} ` +
              `cwd=${safeCwd} ` +
              `stderr: ${stderrBuf.slice(0, 500)}`,
          ),
        );
      }
    }, 10_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const m = text.match(/listening on (https?:\/\/[^\s]+)/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timer);
        res(m[1]);
      }
    });
    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        rej(
          new Error(
            `excalidraw-mcp exited before printing URL (code ${code}). ` +
              `stderr: ${stderrBuf.slice(0, 500)}`,
          ),
        );
      }
    });
  });

  return {
    url,
    dispose: async () => {
      proc.kill('SIGTERM');
      // Give the child up to 1s to clean up; force-kill if it hangs.
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          res();
        }, 1000);
        proc.on('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    },
  };
}
