#!/usr/bin/env bash
# Builds the Lee Link melonDS core (Nintendo DS) to WebAssembly.
# Output: apps/web/public/cores/melonds/leelink-melonds.{js,wasm}
# Requires Emscripten (emsdk), cmake, ninja.
#
# melonDS is GPL-3.0 (see cores/vendor/melonDS/LICENSE). The compiled core and
# our frontend (leelink_melonds.cpp) are distributed under GPL-3.0.
set -euo pipefail

MELONDS_REPO=https://github.com/melonDS-emu/melonDS.git
MELONDS_COMMIT=361ffa9501b631d53d7150fe57dec40a8341f664

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENDOR="$ROOT/cores/vendor"
SRC="$VENDOR/melonDS"
BUILD="$VENDOR/build-melonds"
OUT="$ROOT/apps/web/public/cores/melonds"

if ! command -v emcc >/dev/null; then
  export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.12}"
  # shellcheck disable=SC1091
  source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null
fi

if [ ! -d "$SRC/.git" ]; then
  git clone "$MELONDS_REPO" "$SRC"
fi
git -C "$SRC" fetch --depth 1 origin "$MELONDS_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q "$MELONDS_COMMIT" 2>/dev/null || echo "warning: using existing melonDS checkout"

# -include: melonDS relies on transitive std headers that libc++ doesn't provide.
CXXFLAGS_EXTRA="-O3 -msimd128 -include algorithm -include cstdlib -include cstring"

if [ ! -f "$BUILD/src/libcore.a" ]; then
  emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_QT_SDL=OFF \
    -DENABLE_JIT=OFF -DENABLE_OGLRENDERER=OFF -DENABLE_GDBSTUB=OFF \
    -DENABLE_LTO_RELEASE=OFF -DENABLE_LTO=OFF \
    -DCMAKE_C_FLAGS="-O3 -msimd128" \
    -DCMAKE_CXX_FLAGS="$CXXFLAGS_EXTRA"
  ninja -C "$BUILD" core
fi

mkdir -p "$OUT"
em++ -std=c++17 $CXXFLAGS_EXTRA -fwrapv \
  -I"$SRC/src" -I"$BUILD/src" \
  "$HERE/leelink_melonds.cpp" "$BUILD/src/libcore.a" "$BUILD/src/teakra/src/libteakra.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMelonDSCore \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sSTACK_SIZE=4MB \
  -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr -sFILESYSTEM=0 ${LL_DEBUG:+--profiling-funcs -sASSERTIONS=1} \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP16","HEAPU32","wasmMemory"]' \
  -o "$OUT/leelink-melonds.js"

cp "$SRC/LICENSE" "$OUT/LICENSE.melonDS.txt"
echo "Built $(du -h "$OUT/leelink-melonds.wasm" | cut -f1) -> $OUT"
