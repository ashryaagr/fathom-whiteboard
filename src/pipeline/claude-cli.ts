/**
 * Slim, Electron-free Claude CLI path resolver.
 *
 * Hosts may pass `pathToClaudeCodeExecutable` directly to pipeline
 * functions (Fathom does this — its full Electron-aware
 * `claudeCheck.ts` knows about app-bundle Resources paths and dock-only
 * locations the slim version can't reach). When the host doesn't supply
 * a path, this helper is the fallback: best-effort lookup of common
 * install locations on macOS / Linux. Returns the first match or
 * `null` (the SDK's `query()` then falls back to whatever happens to
 * be on PATH).
 *
 * Originally derived from `src/main/claudeCheck.ts` in the Fathom repo
 * with the Electron `app.getPath('exe')` candidates dropped — those
 * resolve to `Fathom.app/Contents/Resources/bin/claude` and are
 * meaningless outside an Electron host.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Locate a `claude` (Claude Code CLI) binary on disk.
 * Returns absolute path on first match, or `null` if none of the
 * common install locations contain one.
 */
export function resolveClaudeExecutablePath(): string | null {
  const candidates = [
    join(homedir(), '.claude', 'bin', 'claude'),
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* swallow — best-effort lookup */
    }
  }
  return null;
}
