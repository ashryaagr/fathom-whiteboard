---
layout: default
title: Dev container
permalink: /DOCKER/
---

# Dev container

A Docker image with all the build-time dependencies needed to develop clawdSlate without installing them on your host. **This is a build and test environment, not a runtime** — Electron's UI can't render in a headless Docker container. The final `.dmg` still has to be produced on macOS (for `iconutil` and native signing).

## What you can do inside the container

- Run `npm install`, `npm run build`, `npm run typecheck`.
- Run Node-only unit tests (when added).
- Run `electron-builder --linux` if you want to produce a Linux AppImage for experimentation (not officially supported).

## What you *can't* do inside the container

- Launch the Electron window (no display server).
- Produce a signed / notarized macOS `.dmg`.
- Use `iconutil` to regenerate `app/icon.icns` (macOS-only tool).

---

## Dockerfile

See `../Dockerfile` at the repo root (when present; the Dockerfile is optional and not required for the Mac build path).

## Build the image

```bash
docker build -t clawdslate-dev .
```

## Use the container as a dev shell

```bash
docker run --rm -it \
  -v "$PWD":/workspace \
  -w /workspace \
  clawdslate-dev bash
```

Inside the container:
```bash
npm install
npm run typecheck
npm run build
```

---

## Why not run Electron in Docker?

Technically you can run Electron headless under Xvfb, but:
- macOS-specific window-chrome behaviour (`titleBarStyle: 'hiddenInset'`) doesn't translate to a Linux virtual display.
- `@anthropic-ai/claude-agent-sdk` spawns the local `claude` binary, which you'd also need inside the container with your auth.
- The macOS Electron ABI you ship to users doesn't match a Linux container build.

Keep the container for **CI-style checks** and **deterministic builds of the JS side**. Do actual app runs on your Mac.

## CI parity

The container is most useful when you want CI runs (typecheck, build, npm package output) to match exactly what a contributor would run locally on Linux. The Mac packaging step (`npm run dist:mac`) is intentionally not in CI — it requires a Mac runner, and the ad-hoc signing identity is local.
