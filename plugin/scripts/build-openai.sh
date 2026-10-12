#!/bin/bash
# Bake an OpenAI key in, build, and drop the package in ../dist.
#   ./scripts/build-openai.sh ~/Desktop/mykey.txt
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/bake-key.mjs "${1:?usage: build-openai.sh <key file>}"
export JAVA_HOME="${JAVA_HOME_21:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p build
# Put the key-free placeholder back however the build ends.
trap 'cp scripts/baked.empty.ts.txt src/baked.ts' EXIT
./buildPlugin.sh > build/openai-build.log 2>&1 || { tail -30 build/openai-build.log; exit 1; }
mkdir -p ../dist
cp build/outputs/TheDiary.snplg ../dist/TheDiary-openai.snplg

echo "✓ ../dist/TheDiary-openai.snplg — contains your key; copy it to the tablet, do not share it."
