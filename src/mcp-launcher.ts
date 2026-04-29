import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Resolve excalidraw-mcp HTTP endpoint.
//
// Default: hosted — this matches the control experiment (`https://mcp.excalidraw.com/mcp`).
// Zero local build, no bun/vite/express to bring up, and the upstream maintainers
// are already running it.
//
// Optional: spawn a local copy of vendor/excalidraw-mcp on an OS-assigned port.
// Requires the user to have built it first (vendor/excalidraw-mcp/dist/index.js
// must exist; see vendor README for `pnpm install && pnpm run build`).

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

// Spawn vendor/excalidraw-mcp/dist/index.js as a child process bound to an
// OS-assigned port (PORT=0 → server picks a free port and prints the URL on
// stdout). Returns the parsed URL once the "MCP server listening on …" log
// line appears.
export async function spawnLocalMcp(): Promise<McpHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/mcp-launcher.ts → ../vendor/excalidraw-mcp/dist/index.js
  // dist/mcp-launcher.js → ../../vendor/excalidraw-mcp/dist/index.js (when consumers install us)
  // We try both candidate paths and use whichever resolves to an existing file.
  const candidates = [
    resolve(here, '..', 'vendor', 'excalidraw-mcp', 'dist', 'index.js'),
    resolve(here, '..', '..', 'vendor', 'excalidraw-mcp', 'dist', 'index.js'),
  ];
  const fs = await import('node:fs');
  const distPath = candidates.find((p) => fs.existsSync(p));
  if (!distPath) {
    throw new Error(
      `excalidraw-mcp not built. Run \`pnpm install && pnpm run build\` in vendor/excalidraw-mcp, ` +
        `or call resolveHosted() to use https://mcp.excalidraw.com/mcp instead. Looked in:\n  ` +
        candidates.join('\n  '),
    );
  }

  const proc = spawn(process.execPath, [distPath], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((res, rej) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        rej(new Error('excalidraw-mcp did not print listening URL within 10s'));
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
        rej(new Error(`excalidraw-mcp exited before printing URL (code ${code})`));
      }
    });
  });

  return {
    url,
    dispose: async () => {
      proc.kill('SIGTERM');
    },
  };
}
