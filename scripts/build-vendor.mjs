#!/usr/bin/env node
// Postinstall step for fathom-whiteboard.
//
// Clones excalidraw/excalidraw-mcp into vendor/ if it's not there yet,
// patches its src/main.ts so the HTTP transport prints the *actual*
// listening port (not the literal value of process.env.PORT — when
// we pass PORT=0 to get an OS-assigned port, the unmodified upstream
// prints "listening on http://localhost:0/mcp" which is useless for
// our parent-process port detection), and runs `pnpm install &&
// pnpm run build`.
//
// Idempotent: if dist/index.js exists and the patched marker is in
// main.ts, this script is a fast no-op. Skips entirely if pnpm is
// missing (consumers can still use `mcpOverride` with a hosted URL).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const vendorDir = join(root, 'vendor', 'excalidraw-mcp');
const mainTsPath = join(vendorDir, 'src', 'main.ts');
const distEntry = join(vendorDir, 'dist', 'index.js');
const PATCH_MARKER = '// __FATHOM_PORT_PATCH__';

function log(...parts) {
  console.log('[fathom-whiteboard build-vendor]', ...parts);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
  }
}

// 1. Clone if vendor/ is missing.
if (!existsSync(join(vendorDir, 'package.json'))) {
  if (!which('git')) {
    log('git not found; skipping vendor clone (hosted MCP fallback only)');
    process.exit(0);
  }
  mkdirSync(dirname(vendorDir), { recursive: true });
  run('git', [
    'clone',
    '--depth',
    '1',
    'https://github.com/excalidraw/excalidraw-mcp.git',
    vendorDir,
  ]);
}

// 1a. Drop a `.npmignore` inside the cloned vendor dir. Upstream's
// `.gitignore` excludes `dist/`, which is correct for their git
// history but wrong for our published tarball — we want consumers
// to receive the pre-built MCP so they don't need a working clone +
// build at install time. An empty `.npmignore` makes npm stop
// consulting the sibling `.gitignore` for pack purposes; package.json
// `files` remains the allowlist. Idempotent: only writes if missing.
const vendorNpmIgnore = join(vendorDir, '.npmignore');
if (!existsSync(vendorNpmIgnore)) {
  writeFileSync(
    vendorNpmIgnore,
    '# Override upstream .gitignore for npm-pack purposes.\n' +
      '# We ship the pre-built dist/ so consumers do not need to\n' +
      '# re-clone and re-build at install time. Empty = "do not\n' +
      '# exclude anything"; package.json `files` is the allowlist.\n',
    'utf8',
  );
  log('wrote vendor/.npmignore to keep dist/ in publish tarball');
}

// 2. Patch main.ts so the listening line prints the actual port.
// Tarball-installed consumers ship the pre-built dist/ but no src/ —
// in that case the patch is irrelevant (binary already carries it).
if (!existsSync(mainTsPath)) {
  if (existsSync(distEntry)) {
    log('vendor src/ not present; using pre-built dist (tarball install)');
    process.exit(0);
  }
  log('vendor src/main.ts missing AND dist/index.js missing; cannot continue');
  process.exit(1);
}
let mainSrc = readFileSync(mainTsPath, 'utf8');
if (!mainSrc.includes(PATCH_MARKER)) {
  // Find the unmodified listen+log block and replace it. We match on
  // the literal upstream code; if it ever shifts substantially this
  // script will warn instead of silently doing nothing.
  const before = `const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.log(\`MCP server listening on http://localhost:\${port}/mcp\`);
  });`;
  const after = `const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    ${PATCH_MARKER}
    const addr = httpServer.address();
    const actualPort =
      typeof addr === "object" && addr !== null ? addr.port : port;
    console.log(\`MCP server listening on http://localhost:\${actualPort}/mcp\`);
  });`;
  if (!mainSrc.includes(before)) {
    log(
      'WARNING: upstream main.ts shape changed; cannot apply port patch. ' +
        'PORT=0 will print "port=0" instead of the actual port. Local-MCP ' +
        'auto-discovery may break. Update scripts/build-vendor.mjs.',
    );
  } else {
    mainSrc = mainSrc.replace(before, after);
    writeFileSync(mainTsPath, mainSrc, 'utf8');
    log('patched main.ts to print actual listening port');
  }
} else {
  log('main.ts already patched');
}

// 3. Install + build.
const pnpm = which('pnpm');
const npm = which('npm');
const installer = pnpm ?? npm;
if (!installer) {
  log('neither pnpm nor npm on PATH; skipping vendor build');
  process.exit(0);
}

if (!existsSync(join(vendorDir, 'node_modules'))) {
  run(installer, ['install'], { cwd: vendorDir });
} else {
  log('vendor node_modules present; skipping install');
}

if (!existsSync(distEntry)) {
  // pnpm uses `pnpm run build`; npm uses `npm run build`. Either way.
  run(installer, ['run', 'build'], { cwd: vendorDir });
} else {
  log(`dist/index.js present; skipping build (${distEntry})`);
}

log('vendor ready:', distEntry);
