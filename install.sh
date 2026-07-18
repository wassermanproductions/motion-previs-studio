#!/usr/bin/env bash
# Motion Previs Studio macOS installer
#
# Downloads the latest release and installs it to /Applications, bypassing
# the Gatekeeper "app is damaged" false alarm that macOS shows for
# browser-downloaded unsigned apps (terminal downloads aren't quarantined).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wassermanproductions/motion-previs-studio/main/install.sh | bash
set -euo pipefail

REPO="wassermanproductions/motion-previs-studio"

if [ "$(uname -m)" != "arm64" ]; then
  echo "Motion Previs Studio for macOS currently ships for Apple Silicon (M1–M4) only." >&2
  echo "On Intel Macs, build from source — see the README." >&2
  exit 1
fi

echo "Finding the latest Motion Previs Studio release..."
URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o 'https://[^"]*arm64\.dmg' | head -1)"
if [ -z "$URL" ]; then
  echo "Could not find a macOS download — see https://github.com/$REPO/releases" >&2
  exit 1
fi

DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Motion Previs Studio..."
curl -fL --progress-bar "$URL" -o "$TMP/motion-previs-studio.dmg"

echo "Installing to $DEST..."
MNT="$(hdiutil attach "$TMP/motion-previs-studio.dmg" -nobrowse | awk -F'\t' '/\/Volumes\//{print $3; exit}')"
rm -rf "$DEST/Motion Previs Studio v4.app"
ditto "$MNT/Motion Previs Studio v4.app" "$DEST/Motion Previs Studio v4.app"
hdiutil detach "$MNT" -quiet
xattr -cr "$DEST/Motion Previs Studio v4.app" 2>/dev/null || true

echo "✓ Motion Previs Studio installed — launching."
open "$DEST/Motion Previs Studio v4.app"
