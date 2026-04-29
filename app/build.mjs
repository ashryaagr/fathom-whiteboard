// Standalone-app build: tsc the main+preload, esbuild the renderer.
// Output goes to app/dist/. Run before launching Electron.

import { build as esbuild } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');
mkdirSync(out, { recursive: true });
mkdirSync(resolve(out, 'renderer'), { recursive: true });

// Library must be built first; the app imports from ../dist/index.js.
if (!existsSync(resolve(root, 'dist', 'index.js'))) {
  console.log('• building library (tsc)…');
  execSync('npx tsc', { cwd: root, stdio: 'inherit' });
}

// Compile main + preload as ES modules — main.ts uses `import.meta.url`.
console.log('• compiling main…');
await esbuild({
  entryPoints: [resolve(here, 'main.ts')],
  outfile: resolve(out, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    'electron',
    '@anthropic-ai/claude-agent-sdk',
    '@excalidraw/excalidraw',
    'react',
    'react-dom',
    'fathom-whiteboard',
  ],
  banner: {
    // ESM Node modules need to construct __dirname themselves.
    js: "import { createRequire as __cjsCreateRequire } from 'module';\nconst require = __cjsCreateRequire(import.meta.url);",
  },
});

console.log('• compiling preload…');
// Preload is CJS (Electron's contract); package.json has "type": "module"
// so a .js extension would be parsed as ESM. .cjs forces Node to treat it
// as CommonJS regardless of the package-level type.
await esbuild({
  entryPoints: [resolve(here, 'preload.ts')],
  outfile: resolve(out, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

console.log('• bundling renderer…');
await esbuild({
  entryPoints: [resolve(here, 'renderer', 'main.tsx')],
  outfile: resolve(out, 'renderer', 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  // Excalidraw ships its CSS under a `production`/`development`
  // exports condition. Pick `production` so the import resolves at
  // build time.
  conditions: ['production', 'browser', 'import', 'module', 'default'],
  loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Bundle React and Excalidraw into the renderer; mark Node-only
  // packages external so we don't accidentally pull the SDK into the
  // browser bundle (the SDK uses Node fs/spawn which the renderer
  // can't run anyway).
  external: ['@anthropic-ai/claude-agent-sdk'],
});

// HTML doesn't need bundling — copy as-is, point script at the bundled main.
console.log('• copying html…');
copyFileSync(
  resolve(here, 'renderer', 'index.html'),
  resolve(out, 'renderer', 'index.html'),
);

console.log('✓ app build complete: app/dist/');
