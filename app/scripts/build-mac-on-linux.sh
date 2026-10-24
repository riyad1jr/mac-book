#!/usr/bin/env bash
# Build the Mac (Apple Silicon) app from Windows using WSL (Ubuntu), or from Linux.
# This is exactly how the Mac builds have been made.
#
# One-time setup on Windows:  open PowerShell as admin ->  wsl --install  -> restart,
# open "Ubuntu" from the Start menu, then inside Ubuntu:
#     sudo apt update && sudo apt install -y curl zip unzip
#     curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
# Then copy the source folder into Ubuntu (e.g. cp -r /mnt/c/Users/YOU/Downloads/app ~/app),
# cd into it and run:   bash scripts/build-mac-on-linux.sh
# Result: mame-mac.zip in this folder - send it to the Mac, unzip, drag into Applications.
set -euo pipefail
cd "$(dirname "$0")/.."

RCODESIGN_VERSION=0.29.0
TOOLS="$HOME/.mame-build-tools"
RCODESIGN="$TOOLS/apple-codesign-$RCODESIGN_VERSION-x86_64-unknown-linux-musl/rcodesign"
if [ ! -x "$RCODESIGN" ]; then
  echo "Downloading rcodesign (signs the app so Apple-chip Macs will open it)..."
  mkdir -p "$TOOLS"
  curl -fsSL -o "$TOOLS/rcodesign.tar.gz" \
    "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$RCODESIGN_VERSION/apple-codesign-$RCODESIGN_VERSION-x86_64-unknown-linux-musl.tar.gz"
  tar -xzf "$TOOLS/rcodesign.tar.gz" -C "$TOOLS"
fi

echo "Installing packages..."; npm install
echo "Building the app...";    npm run build
echo "Packaging for Mac...";   rm -rf release/mac-arm64; npx electron-builder --mac dir --arm64
APP="release/mac-arm64/Mame Inventory.app"
echo "Signing...";             "$RCODESIGN" sign "$APP"
echo "Zipping...";             rm -f mame-mac.zip; (cd release/mac-arm64 && zip -r -y -9 -q ../../mame-mac.zip "Mame Inventory.app")
ls -l mame-mac.zip
echo "Done: mame-mac.zip  (on the Mac: unzip, drag into Applications; first time: Privacy & Security > Open Anyway)"
