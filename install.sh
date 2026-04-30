#!/usr/bin/env bash
# Slate installer + updater.
#
# This one script is both:
#   - the first-time installer (curl … | bash)
#   - the update mechanism (re-run it, or pass --from-zip pointing at a
#     pre-downloaded local copy)
#
# It avoids the DMG / Squirrel.Mac path because those require a stable
# code-signing identity across builds, which we don't have (we ad-hoc
# sign every release). Instead we treat Slate.app as a plain ZIP
# archive: download → extract → ad-hoc re-sign → clear quarantine →
# launch. This works indefinitely with ad-hoc signing and needs zero
# GUI steps.
#
# Usage:
#   # First install
#   curl -fsSL https://raw.githubusercontent.com/ashryaagr/fathom-whiteboard/main/install.sh | bash
#
#   # Install a specific version
#   curl … | bash -s -- --version v0.1.8
#
#   # Update from an already-downloaded zip (used when you grabbed the
#   # zip manually instead of via the registry path)
#   ./install.sh --from-zip /tmp/slate.zip --relaunch
#
#   # Uninstall
#   ./install.sh --uninstall

set -euo pipefail

REPO_OWNER="ashryaagr"
REPO_NAME="fathom-whiteboard"
APP_NAME="Slate"
BUNDLE_NAME="${APP_NAME}.app"
LAUNCHER_NAME="slate"

# --- Flags -----------------------------------------------------------------

VERSION=""                # empty = latest
FROM_ZIP=""               # local zip path
WAIT_PID=""               # wait for this pid to exit before swap
RELAUNCH=0                # open the app after install
UNINSTALL=0
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)       VERSION="$2"; shift 2 ;;
    --from-zip)      FROM_ZIP="$2"; shift 2 ;;
    --wait-pid)      WAIT_PID="$2"; shift 2 ;;
    --relaunch)      RELAUNCH=1; shift ;;
    --uninstall)     UNINSTALL=1; shift ;;
    --quiet)         QUIET=1; shift ;;
    -h|--help)
      sed -n '3,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log() { [[ $QUIET -eq 1 ]] || printf "%b\n" "$*"; }
die() { printf "Error: %s\n" "$*" >&2; exit 1; }

# --- OS + arch sanity checks ----------------------------------------------

[[ "$(uname)" == "Darwin" ]] || die "Slate only runs on macOS."

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="arm64" ;;   # Intel builds not shipped yet; fall back so the download works
  *) die "Unsupported architecture: $ARCH_RAW" ;;
esac

# --- Install location -----------------------------------------------------
# Prefer /Applications. Fall back to ~/Applications if /Applications isn't
# writable (managed Macs). Both are legitimate macOS app homes.

if [[ -w "/Applications" ]] || [[ ! -d "/Applications" ]]; then
  INSTALL_DIR="/Applications"
else
  INSTALL_DIR="${HOME}/Applications"
  mkdir -p "$INSTALL_DIR"
fi
APP_PATH="${INSTALL_DIR}/${BUNDLE_NAME}"
LAUNCHER_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${LAUNCHER_DIR}/${LAUNCHER_NAME}"

# --- Uninstall ------------------------------------------------------------

if [[ $UNINSTALL -eq 1 ]]; then
  log "Uninstalling Slate from ${APP_PATH}…"
  rm -rf "$APP_PATH" || true
  rm -f "$LAUNCHER_PATH" || true
  log "Done. (Per-session canvas state under ~/Library/Application Support/Slate is untouched.)"
  exit 0
fi

# --- Wait on a running copy ----------------------------------------------

if [[ -n "$WAIT_PID" ]]; then
  log "Waiting for Slate (pid $WAIT_PID) to exit…"
  for _ in $(seq 1 75); do
    if ! kill -0 "$WAIT_PID" 2>/dev/null; then break; fi
    sleep 0.2
  done
fi

# --- Acquire the zip ------------------------------------------------------

WORK_DIR="$(mktemp -d /tmp/slate-install.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
ZIP_PATH="${WORK_DIR}/${APP_NAME}-${ARCH}.zip"

if [[ -n "$FROM_ZIP" ]]; then
  [[ -f "$FROM_ZIP" ]] || die "--from-zip '$FROM_ZIP' doesn't exist."
  log "Using local zip ${FROM_ZIP}…"
  cp "$FROM_ZIP" "$ZIP_PATH"
else
  if [[ -z "$VERSION" ]]; then
    URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${APP_NAME}-${ARCH}.zip"
    log "Fetching latest Slate…"
  else
    [[ "$VERSION" == v* ]] || VERSION="v${VERSION}"
    URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${VERSION}/${APP_NAME}-${ARCH}.zip"
    log "Fetching Slate ${VERSION}…"
  fi
  curl -fL --retry 3 --retry-delay 1 -o "$ZIP_PATH" "$URL" \
    || die "Download failed. Check your internet connection, or pass --version explicitly."
fi

# --- Extract --------------------------------------------------------------

log "Extracting…"
EXTRACT_DIR="${WORK_DIR}/extract"
mkdir -p "$EXTRACT_DIR"
ditto -x -k "$ZIP_PATH" "$EXTRACT_DIR" \
  || die "Extraction failed. Zip may be corrupt."
[[ -d "${EXTRACT_DIR}/${BUNDLE_NAME}" ]] \
  || die "Extracted archive has no ${BUNDLE_NAME} inside."

# --- Swap in place --------------------------------------------------------

if [[ -e "$APP_PATH" ]]; then
  log "Replacing existing ${APP_PATH}…"
  BACKUP_PATH="${WORK_DIR}/${BUNDLE_NAME}.bak"
  mv "$APP_PATH" "$BACKUP_PATH"
fi

log "Installing to ${APP_PATH}…"
ditto "${EXTRACT_DIR}/${BUNDLE_NAME}" "$APP_PATH"

# --- Clean quarantine + ad-hoc sign ---------------------------------------

xattr -cr "$APP_PATH" 2>/dev/null || true

if command -v codesign >/dev/null 2>&1; then
  log "Ad-hoc signing…"
  codesign --deep --force --sign - "$APP_PATH" 2>/dev/null \
    || log "  (codesign warning — app may still launch)"
else
  log "codesign not found on PATH — skipping ad-hoc signature."
fi

# --- Install the slate CLI launcher --------------------------------------

log "Installing CLI launcher at ${LAUNCHER_PATH}…"
mkdir -p "$LAUNCHER_DIR"
cat > "$LAUNCHER_PATH" <<'LAUNCHER_EOF'
#!/usr/bin/env bash
# Slate CLI — thin wrapper that launches the Slate.app.
#
# Usage:
#   slate                    # open Slate
#   slate update             # pull the latest version
#   slate --version          # print the installed version
#   slate uninstall          # remove Slate

set -e

APP_NAME="Slate"
if [[ -d "/Applications/${APP_NAME}.app" ]]; then
  APP="/Applications/${APP_NAME}.app"
elif [[ -d "${HOME}/Applications/${APP_NAME}.app" ]]; then
  APP="${HOME}/Applications/${APP_NAME}.app"
else
  echo "Slate not installed. Run:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/ashryaagr/fathom-whiteboard/main/install.sh | bash" >&2
  exit 1
fi

case "${1:-}" in
  update)
    echo "Updating Slate…"
    exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/ashryaagr/fathom-whiteboard/main/install.sh)"
    ;;
  uninstall)
    exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/ashryaagr/fathom-whiteboard/main/install.sh) --uninstall"
    ;;
  --version|-v|version)
    PLIST="${APP}/Contents/Info.plist"
    if [[ -f "$PLIST" ]]; then
      /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST"
    else
      echo "unknown"
    fi
    ;;
  --help|-h|help)
    sed -n '3,9p' "$0"
    ;;
  "")
    exec open -a "$APP"
    ;;
  *)
    exec open -a "$APP" "$@"
    ;;
esac
LAUNCHER_EOF
chmod +x "$LAUNCHER_PATH"

# --- PATH hint ------------------------------------------------------------

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LAUNCHER_DIR"; then
  log ""
  log "Note: ${LAUNCHER_DIR} is not on your PATH."
  log "      Add this line to your ~/.zshrc (or ~/.bashrc):"
  log "          export PATH=\"\${HOME}/.local/bin:\${PATH}\""
fi

# --- Relaunch / final message ---------------------------------------------

if [[ $RELAUNCH -eq 1 ]]; then
  log "Relaunching Slate…"
  open -a "$APP_PATH" || true
  exit 0
fi

log "Launching Slate…"
open -a "$APP_PATH" || true

log ""
log "✓ Slate installed to ${APP_PATH}"
log ""
log "Terminal shortcuts (if ~/.local/bin is on PATH):"
log "  slate                    # launch Slate"
log "  slate update             # pull the latest version"
