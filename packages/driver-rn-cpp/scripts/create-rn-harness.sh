#!/usr/bin/env bash
# Creates the WmHarness React Native app the android-driver lanes build:
# a real `cli init` app with the PACKED core and driver-rn-cpp tarballs
# installed and the e2e harness files copied over the template's own.
# RN and CLI versions are pinned by the caller — never @latest — so a
# lane failure means the code changed, not the ecosystem.
#
# Usage:
#   create-rn-harness.sh --react-native 0.86.0 --cli 20.2.0 \
#     --tarballs /tmp/packed --output /tmp/WmHarness
set -euo pipefail

RN_VERSION="" CLI_VERSION="" TARBALLS="" OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --react-native) RN_VERSION="$2"; shift 2 ;;
    --cli) CLI_VERSION="$2"; shift 2 ;;
    --tarballs) TARBALLS="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$RN_VERSION" ] || [ -z "$CLI_VERSION" ] || [ -z "$TARBALLS" ] || [ -z "$OUTPUT" ]; then
  echo "usage: $0 --react-native <ver> --cli <ver> --tarballs <dir> --output <dir>" >&2
  exit 1
fi

E2E_DIR="$(cd "$(dirname "$0")/../e2e" && pwd)"
APP_NAME="$(basename "$OUTPUT")"
cd "$(dirname "$OUTPUT")"
rm -rf "$APP_NAME"
npx -y "@react-native-community/cli@${CLI_VERSION}" init "$APP_NAME" \
  --version "$RN_VERSION" --pm npm --skip-install --install-pods false
cd "$APP_NAME"
npm install
npm install "$TARBALLS"/*core*.tgz "$TARBALLS"/*driver-rn-cpp*.tgz
# Hermes has no WebCrypto and randomId requires it, so the harness needs
# the same polyfill a real app does (docs/reference/runtimes.md). Pinned
# like everything else here: a lane failure must mean the code changed.
npm install react-native-get-random-values@1.11.0
cp "$E2E_DIR/App.tsx" App.tsx
cp "$E2E_DIR/vitest-shim.ts" vitest-shim.ts
cp "$E2E_DIR/metro.config.js" metro.config.js
cp "$E2E_DIR/babel.config.js" babel.config.js
echo "harness ready: $OUTPUT (react-native ${RN_VERSION}, cli ${CLI_VERSION})"
