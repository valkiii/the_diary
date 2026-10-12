#!/bin/bash
# Bake the diary bridge's address and token in, build, and drop the package in ../dist.
#   ./scripts/build-bridge.sh http://192.168.1.20:8787/v1 [model]
# The token is read from ../bridge/.diary-token (created if missing). The .snplg
# built here CONTAINS THE TOKEN: keep it to yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:?usage: build-bridge.sh <bridge url, e.g. http://192.168.1.20:8787/v1> [model]}"
MODEL="${2:-claude}"
TOKEN_FILE=../bridge/.diary-token
[ -s "$TOKEN_FILE" ] || { LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 20 > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; }
TOKEN=$(cat "$TOKEN_FILE")
cat > src/baked.ts <<TS
/**
 * Settings baked into this build by scripts/build-bridge.sh.
 * Holds the bridge token: do not share the .snplg built from it.
 */
import type {Settings} from './settings';

export const BAKED: Partial<Settings> = {
  baseUrl: '$URL',
  apiKey: '$TOKEN',
  model: '$MODEL',
};
TS
export JAVA_HOME="${JAVA_HOME_21:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p build
trap 'cp scripts/baked.empty.ts.txt src/baked.ts' EXIT
./buildPlugin.sh > build/bridge-build.log 2>&1 || { tail -30 build/bridge-build.log; exit 1; }
mkdir -p ../dist
cp build/outputs/TheDiary.snplg ../dist/TheDiary-bridge.snplg
echo "✓ ../dist/TheDiary-bridge.snplg — start the bridge with: DIARY_TOKEN=\$(cat bridge/.diary-token) node bridge/diary-bridge.mjs"
