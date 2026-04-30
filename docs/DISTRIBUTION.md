---
layout: default
title: Distribution strategy
permalink: /DISTRIBUTION/
---

# Distribution strategy

Slate is distributed without an Apple Developer ID. This page documents
how that constraint shapes every install and update path, and why the
design converges on one script — `install.sh` — powering both.

## The constraint: ad-hoc signing

An Apple Developer ID costs $99/year and attaches a stable cryptographic
identity to every build. With one, macOS Gatekeeper lets the app launch
without a warning, and Squirrel.Mac (electron-updater's install engine)
can swap bundles in place on update because the "designated requirement"
stays the same across versions.

Without one, we ad-hoc sign. `codesign --deep --force --sign -` runs on
every build and produces a valid-but-identityless signature. The linker
is happy; the kernel loader is happy; Gatekeeper can be taught to open
the app once with the *right-click → Open* ritual. But Squirrel.Mac
refuses: the "code requirement" it derives from the running app doesn't
match the next build (CDHash is content-derived, so every rebuild looks
like a different identity), and it throws:

```
code failed to satisfy specified code requirement(s)
```

…and fails the install.

## The two install paths (both supported)

### Option A — DMG

```
Slate-arm64.dmg  →  drag to /Applications  →  right-click → Open (once)
```

Familiar to any Mac user. What 80% of users will reach for. Ships the
exact same `Slate.app` that Option B delivers.

### Option B — `install.sh` via curl

```
curl -fsSL …/install.sh | bash
```

Same as the install flow developers know from Claude Code, `rustup`,
`nvm`, `deno`, Homebrew. The script:

1. Downloads `Slate-arm64.zip` from GitHub Releases.
2. Extracts to `/Applications/Slate.app` (or `~/Applications/` on
   managed Macs where `/Applications` isn't writable).
3. Clears the `com.apple.quarantine` extended attribute — `curl`
   doesn't set it the way Safari does, so Gatekeeper treats the
   extracted bundle as a locally-built app and doesn't prompt. **No
   right-click → Open ritual.**
4. Re-applies ad-hoc signing so the loader stays happy.
5. Installs a `slate` launcher at `~/.local/bin/slate` for terminal
   use.

For users who distrust piping curl into bash (a healthy instinct), the
README documents the `curl -o install.sh; less install.sh; bash install.sh`
pattern. The script is ~230 lines of readable shell.

## Why the same script also powers updates

Auto-updating is exactly the same problem as first-install: replace an
existing `Slate.app` bundle with a new one. Once we have a script that
does this correctly for the install case, there's no reason to write a
*second* mechanism for updates.

Slate's update mechanism is intentionally simple: the user re-runs
`install.sh`, either directly (`curl … | bash`) or via the bundled
`slate` launcher (`slate update`). The launcher's `update` subcommand
fetches and runs the latest `install.sh` from main:

```bash
slate update
# is equivalent to
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh)"
```

The script:

1. Sees the existing `/Applications/Slate.app`, treats this as an
   update.
2. Downloads the latest `Slate-arm64.zip`.
3. Optionally `--wait-pid <pid>` — waits for the running Slate to
   exit before swapping the bundle. The launcher passes this when
   invoked from inside the running app (future capability).
4. Replaces the bundle, clears quarantine, re-signs, relaunches.

The user runs one command → the app vanishes for ~5 seconds → the
new version comes back. No dialogs, no Finder interaction, no
Squirrel, no DMG mount.

**Critically, this works identically regardless of whether the user
installed via DMG or via curl.** Both paths produced the same
`Slate.app`; both are updated by the same script.

## Why this design

1. **One mechanism to test.** We only have to keep `install.sh`
   working. Breaking the update path means breaking the install path
   — and users will notice that before a release ships.
2. **No Apple Developer fee.** $99/year is cheap insurance for a
   commercial product; for a free, open-source tool shipped by one
   person, it's overhead that adds no meaningful user-facing value.
3. **Works in both audiences.** DMG for users who expect DMG. Terminal
   for users who expect curl-pipe-bash. Neither camp is asked to
   adopt the other camp's ritual.
4. **Auditable.** The script is in the repo, reviewable on GitHub,
   readable in ~230 lines. The launcher (`slate`) is a thin wrapper
   that shells out to the same script.

## When to revisit

We'd switch to Developer ID signing when any of these become true:

- **Slate ships to a non-technical audience at scale.** First-install
  friction (the right-click → Open ritual for DMG users) is a real
  drop-off point for users who aren't developers. Developer ID removes
  it.
- **macOS tightens ad-hoc signing further.** Sequoia (15+) has
  already introduced some edge cases where ad-hoc-signed apps from
  outside the App Store can trigger additional warnings. If a future
  macOS version blocks them outright, we'd need to pivot.
- **The install script starts accumulating edge cases.** If we find
  ourselves writing special-case logic for obscure filesystem layouts
  or permissions setups, Apple's signing + Gatekeeper machinery
  becomes worth the $99.

Until then, the script is the cleanest path. See
[`install.sh`]({{ '/install.sh' | relative_url }}) for the code.

## Files involved

```
install.sh                          # the universal install/update script
electron-builder.config.cjs         # bundles + configures DMG + zip targets
docs/INSTALL.md                     # user-facing install guide
docs/DISTRIBUTION.md                # this file
```

## Testing a release end-to-end

Per the lesson learned the hard way (Fathom's v1.0.0 → v1.0.1 shipped
with a broken Squirrel-based update path; Slate adopts that lesson by
construction), every release **must** be tested on a real version
bump before being declared done:

```bash
# Install v(N) on a clean machine
curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh | bash
open -a Slate     # verify it launches

# Ship v(N+1) to GitHub Releases
npm run dist:mac
gh release create v(N+1) release/Slate-arm64.{dmg,zip}

# In the running v(N) app's terminal:
slate update
# Expect: "Updating Slate…" → app vanishes → relaunches at v(N+1)
slate --version    # confirms v(N+1)
```

This loop is captured as a skill for the agent harness: see
[`.claude/skills/slate-release.md`]({{ '/release-skill' | relative_url }})
in the source tree.

## What we don't do (and why)

- **No `latest-mac.yml`.** Squirrel.Mac is not in our path. The
  in-app updater (when we add one) will spawn `install.sh` directly
  rather than parse `electron-updater` metadata.
- **No code-signing CI step.** Releases are built locally by the
  maintainer on Apple Silicon. Adding CI signing would require
  storing the (ad-hoc) signing identity in CI secrets, and the
  identity is anchored to the local machine — there's no portable
  identity to upload.
- **No notarisation.** Notarisation requires an Apple Developer ID,
  which we don't have. The clear-quarantine xattr step in
  `install.sh` is the substitute for users on the curl path; DMG
  users do the one-time Gatekeeper approval.
