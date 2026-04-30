---
name: slate-release
description: Build, sign, and publish a new Slate release; verify the install/update path works end-to-end before declaring done. Use when shipping a version bump.
type: skill
---

# Slate release pipeline

Slate ships as a single `Slate.app` bundle, distributed via both DMG and
a `curl | bash` install script. Both are generated from the same build.
See [docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md) for the design.

## When to use this skill

- User says "cut a release" / "ship v0.1.9".
- A non-trivial feature has landed on main and needs to reach users.
- A bugfix affects distribution / install / update flow — those
  **must** be tested on a real version bump, not just in dev.

## Prerequisites on the dev machine

- macOS Apple Silicon with Xcode CLI tools (for `codesign`, `ditto`).
- `gh` CLI, authenticated against github.com/ashryaagr/slate.
- Node 22+, npm, dependencies installed.
- A clean working tree (no untracked files in `release/`).

## The pipeline

```bash
# 0. Confirm working tree clean + on main
git status
git branch --show-current       # expect: main

# 1. Bump the version
#    Follow SemVer. Anything touching install/update is at least a minor.
npm version <patch|minor|major> --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "Releasing v$VERSION"

# 2. Build the mac artifacts — arm64 only for v0.1
npm run dist:mac
# Produces:
#   release/Slate-arm64.dmg   — drag-to-Applications installer
#   release/Slate-arm64.zip   — zipped .app (what install.sh consumes)

# 3. Verify the ad-hoc signature before uploading
codesign --verify --deep --strict "release/mac-arm64/Slate.app"
# Expect: no output + exit 0. Any error here means the build hook broke.

# 4. Tag and push
git add package.json package-lock.json
git commit -m "v$VERSION"
git tag "v$VERSION"
git push origin main
git push origin "v$VERSION"

# 5. Create the GitHub release with all artifacts
gh release create "v$VERSION" \
  release/Slate-arm64.dmg \
  release/Slate-arm64.zip \
  --title "v$VERSION" \
  --notes-file RELEASE_NOTES.md    # or --generate-notes

# 6. (Optional) Publish the npm package if its surface changed
#    Slate ships the same component as `fathom-whiteboard` on npm.
npm publish
```

## Mandatory end-to-end verification (do not skip)

Lessons from past Fathom releases: update paths that look right in
code have failed in the real world. Every release **must** be
verified with a real version-bump install before it's declared
done.

### Slate's update mechanism

Slate does NOT use Squirrel.Mac or electron-updater for the
download/install path. The same `install.sh` script is the universal
install AND update mechanism. To update, the user (or the in-app
"slate update" command) re-runs the script. The script:

1. Downloads `Slate-arm64.zip` from the latest GitHub Release.
2. Replaces `/Applications/Slate.app` (or `~/Applications/Slate.app`).
3. Clears the `com.apple.quarantine` xattr.
4. Re-applies ad-hoc signing.
5. Re-installs the `slate` launcher at `~/.local/bin/slate`.

This works identically regardless of whether the user installed via
DMG or via curl. Both paths produce the same `Slate.app`; both are
updated by the same script.

### Special case: the release changes install.sh

If this release modifies `install.sh` itself, the existing user's
v(N-1) `slate update` command STILL fetches the new script (it
hits `raw.githubusercontent.com/.../install.sh` at run-time, not
a bundled copy). So `install.sh` changes ARE auto-applied — but
only if the user actually runs `slate update`. There's no
auto-check; Slate doesn't ship a daemon.

If a release fixes a bug that prevented users from getting *to*
the update mechanism (e.g. a crash on launch that prevented them
from typing `slate update`), the release notes must call it out:

> "If you're stuck on v(N-1), run this one-liner once to catch up:
> `curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh | bash`"

### Normal release test loop

```bash
# In a separate terminal, install the PREVIOUS version and confirm
# the update path works:

# 1. Install v(N-1) fresh (or keep your existing install)
#    If starting fresh:
curl -fsSL https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh \
  | bash -s -- --version "v$PREV_VERSION"

# 2. Launch it
slate
# Verify: title bar / About menu shows vPREV_VERSION.

# 3. Update via the launcher
slate update
# Expected: re-runs install.sh against latest, swaps the bundle,
# relaunches Slate at vNEW.

# 4. Verify
slate --version    # prints vNEW
slate              # opens, paste-prompt visible

# 5. Verify the curl install works for first-time users too
#    (clean machine simulation)
sudo rm -rf /Applications/Slate.app   # only on a test machine!
curl -fsSL …/install.sh | bash
open -a Slate
# Expect: app launches immediately, no Gatekeeper warning.
```

If any step fails, **do not declare the release done**. Fix the bug,
bump the patch version, and re-release. A broken update mechanism
means every user gets stuck on the previous version.

## Post-release: confirm install.sh is up to date

The install script URL is `https://raw.githubusercontent.com/ashryaagr/slate/main/install.sh`.
If `install.sh` itself changed as part of this release, make sure the
commit landed on main before announcing — otherwise new users will pull
a stale script.

## Rollback

Releases are additive. To "roll back":

```bash
# 1. Delete the broken release tag
gh release delete "v$BAD_VERSION" --yes
git push --delete origin "v$BAD_VERSION"

# 2. Re-publish the previous release with the same asset names so that
#    /releases/latest/download/<asset> points to the good version again.
gh release edit "v$PREV_VERSION" --latest
```

A user who already updated to the broken version is stuck on it
until the next release — but `slate update` will pull the
re-promoted version once they run it. Encourage that in the
rollback announcement.

## Checklist before calling it done

- [ ] Working tree clean, on main.
- [ ] Version bumped in `package.json`.
- [ ] `npm run dist:mac` completed without errors.
- [ ] `codesign --verify --deep --strict` passed.
- [ ] Release created on GitHub with both artifacts uploaded.
- [ ] v(N-1) running copy updated to vN cleanly via `slate update`.
- [ ] `slate --version` confirms vN after update.
- [ ] Fresh `curl | bash` install produces a launchable app with no
      Gatekeeper warning.
- [ ] No error lines in DevTools console after a full round-trip
      paste → generate → refine → restart.
- [ ] If `WhiteboardHost` contract or pipeline exports changed, npm
      package republished with matching version.
