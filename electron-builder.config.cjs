/**
 * electron-builder config for clawdSlate (the standalone whiteboard app).
 *
 * clawdSlate is published from this repo alongside the npm package
 * `fathom-whiteboard`. Two distinct artifacts share one source tree:
 *  - `dist/` is the npm-published library (consumed by Fathom).
 *  - `release/` is the Mac app bundle (this config's output).
 *
 * The repo's `dist/` is the runtime library output that
 * `app/main.ts` imports via `'../dist/index.js'`, so we ship it
 * inside the asar (see `files` below). The electron-builder output
 * goes to `release/` to avoid colliding with the lib directory.
 *
 * Distribution: ad-hoc signed (no Apple Developer ID yet). Without
 * the inline afterSign hook below, Gatekeeper would refuse the
 * downloaded app as "damaged" on macOS Ventura+. With it, users see
 * "unidentified developer" and can approve once via System Settings.
 * When an Apple Developer ID becomes available, set `mac.identity`
 * to the cert's Common Name, flip `hardenedRuntime` to true, add
 * notarize credentials, and remove the afterSign hook.
 */

const { execSync } = require('node:child_process');

module.exports = {
  appId: 'com.ashrya.clawdslate',
  productName: 'clawdSlate',
  directories: {
    // Keep electron-builder out of the lib's `dist/` directory.
    output: 'release',
  },
  files: [
    // The Electron entry compiled from `app/main.ts` and its preload +
    // renderer bundle.
    'app/dist/**',
    // Dock icon read at runtime via app/main.ts:301.
    'app/icon-1024.png',
    // The lib's tsc output that `app/dist/main.js` imports from
    // `../dist/index.js`. Required at runtime.
    'dist/**',
    // Vendored excalidraw-mcp. Built dist + its package.json (the SDK's
    // `import.meta.url` resolves relative to the .js file). The full
    // `vendor/excalidraw-mcp/**` would also pull node_modules etc.;
    // restrict to what's actually needed.
    'vendor/excalidraw-mcp/dist/**',
    'vendor/excalidraw-mcp/package.json',
    // Top-level package.json for electron-builder + Electron's main lookup.
    'package.json',
    // Standard noise exclusions.
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
    '!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}',
    '!**/node_modules/*.d.ts',
    '!**/node_modules/.bin',
    '!**/*.{iml,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,xproj}',
    '!.editorconfig',
    '!**/._*',
    '!**/{.DS_Store,.git,.hg,.svn,CVS,RCS,SCCS,.gitattributes,.gitignore,.gitkeep}',
  ],
  // Override package.json's `main` (which points at the npm lib entry)
  // so Electron knows to launch the Mac app entry instead.
  extraMetadata: {
    main: 'app/dist/main.js',
  },
  asarUnpack: [
    // `mcp-launcher.ts` calls `child_process.spawn(execPath, [<vendor>])`.
    // Paths under app.asar can be Read via Electron's hook but not
    // executed by spawned children — the syscall hits the real
    // filesystem and sees app.asar as a FILE → ENOTDIR. Unpack so
    // the spawned process gets a real path.
    'vendor/excalidraw-mcp/**',
    // The Claude Agent SDK spawns a bundled `claude` binary. Same asar
    // restriction. clawdSlate threads `pathToClaudeCodeExecutable` through
    // `runAgent` opts; in this packaged app the SDK's default
    // resolution lands inside app.asar without unpack and the spawn
    // fails with ENOTDIR (~126ms). Mirror Fathom's pattern.
    'node_modules/@anthropic-ai/claude-agent-sdk/**',
  ],
  // Versionless asset names so /releases/latest/download/<asset>
  // always resolves to current.
  artifactName: 'clawdSlate-${arch}.${ext}',
  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg' }, { target: 'zip' }],
    identity: null,             // ad-hoc sign in afterSign below
    hardenedRuntime: false,
    gatekeeperAssess: false,
    icon: 'app/icon.icns',
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    icon: 'app/icon-1024.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'clawdSlate-Setup-${version}-${arch}.${ext}',
  },
  dmg: {
    title: 'clawdSlate ${version}',
    sign: false,
    icon: 'app/icon.icns',
    window: { width: 540, height: 380 },
    contents: [
      { x: 130, y: 180, type: 'file' },
      { x: 410, y: 180, type: 'link', path: '/Applications' },
    ],
  },
  // clawdSlate has no native modules and the vendored excalidraw-mcp is
  // pre-built on disk before this runs. Skip rebuild + skip running
  // postinstall hooks at packaging time.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  publish: [
    {
      provider: 'github',
      owner: 'ashryaagr',
      repo: 'clawdslate',
      releaseType: 'release',
    },
  ],
  // Ad-hoc sign the produced .app bundle. electron-builder's signing
  // pass is a no-op when identity:null; without this hook, codesign
  // --verify reports "code has no resources but signature indicates
  // they must be present" and Gatekeeper rejects the downloaded app
  // with "damaged" on Ventura+.
  afterSign: async (context) => {
    if (context.packager.platform.name !== 'mac') return;
    const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
    console.log(`[afterSign] ad-hoc signing ${appPath}`);
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' });
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
    console.log('[afterSign] signature verified ✓');
  },
};
