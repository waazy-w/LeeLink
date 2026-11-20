#!/usr/bin/env bash
# Builds the Lee Link mGBA core (GB / GBC / GBA) to WebAssembly.
# Output: apps/web/public/cores/mgba/leelink-mgba.{js,wasm}
# Requires Emscripten (emsdk), cmake, ninja.
set -euo pipefail

MGBA_REPO=https://github.com/mgba-emu/mgba.git
MGBA_COMMIT=9fcaa88

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENDOR="$ROOT/cores/vendor"
SRC="$VENDOR/mgba"
BUILD="$VENDOR/build-mgba"
OUT="$ROOT/apps/web/public/cores/mgba"

if ! command -v emcc >/dev/null; then
  # shellcheck disable=SC1091
  source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null
fi

if [ ! -d "$SRC/.git" ]; then
  git clone "$MGBA_REPO" "$SRC"
fi
git -C "$SRC" fetch --depth 1 origin "$MGBA_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q "$MGBA_COMMIT" 2>/dev/null || echo "warning: using existing mGBA checkout"

COMMON_DEFS="-DDISABLE_THREADING -D_GNU_SOURCE"

if [ ! -f "$BUILD/libmgba.a" ]; then
  mkdir -p "$BUILD"
  emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_STATIC=ON -DBUILD_SHARED=OFF \
    -DDISABLE_FRONTENDS=ON -DDISABLE_DEPS=ON \
    -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF \
    -DENABLE_DEBUGGERS=OFF -DENABLE_GDB_STUB=OFF -DENABLE_SCRIPTING=OFF \
    -DUSE_LUA=OFF -DUSE_JSON_C=OFF -DUSE_FREETYPE=OFF -DUSE_EPOXY=OFF \
    -DUSE_EDITLINE=OFF -DUSE_SQLITE3=OFF -DUSE_ELF=OFF -DUSE_LZMA=OFF \
    -DUSE_ZLIB=OFF -DUSE_PNG=OFF -DUSE_FFMPEG=OFF -DUSE_LIBZIP=OFF \
    -DUSE_MINIZIP=OFF -DUSE_DISCORD_RPC=OFF -DBUILD_LTO=OFF \
    -DHAVE_PTHREAD_H=0 \
    -DCMAKE_C_FLAGS="$COMMON_DEFS -O3"
  ninja -C "$BUILD" mgba
fi

mkdir -p "$OUT"
# Defines must match libmgba's so struct layouts agree.
emcc -O3 -std=c11 $COMMON_DEFS \
  -DBUILD_STATIC -DENABLE_DIRECTORIES -DENABLE_VFS -DENABLE_VFS_FD -DM_CORE_GB -DM_CORE_GBA \
  -I"$SRC/include" -I"$SRC/src" -I"$BUILD/include" \
  "$HERE/leelink_mgba.c" "$BUILD/libmgba.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMgbaCore \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB \
  -sFILESYSTEM=0 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP16","HEAPU32","wasmMemory"]' \
  -o "$OUT/leelink-mgba.js"

echo "Built $(du -h "$OUT/leelink-mgba.wasm" | cut -f1) -> $OUT"
