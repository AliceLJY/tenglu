#!/bin/bash
# 批量对帧目录做 OCR，结果缓存成 JSON —— 文本锚点架构的输入。
#
#   ./anchor-ocr-frames.sh <帧目录> <缓存目录>
#
# 每帧一个 JSON（macOS Vision，带 x/y/w/h 坐标）。已有缓存的帧跳过，
# 所以反复调参不会重复付 OCR 的钱。真机上这一步由 ML Kit 承担。
set -euo pipefail
FRAMES=${1:?用法: $0 <帧目录> <缓存目录>}
CACHE=${2:?用法: $0 <帧目录> <缓存目录>}
OUTDIR="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUTDIR"
BIN="$OUTDIR/ocrbin"

if [ ! -x "$BIN" ] || [ "$(dirname "$0")/anchor-ocr.swift" -nt "$BIN" ]; then
  echo "编译 anchor-ocr.swift → out/ocrbin" >&2
  swiftc -O "$(dirname "$0")/anchor-ocr.swift" -o "$BIN"
fi

mkdir -p "$CACHE"
ls "$FRAMES" | grep -E '\.(jpg|jpeg|png|bmp)$' | sort | while read -r f; do
  out="$CACHE/${f%.*}.json"
  [ -s "$out" ] || echo "$f"
done | xargs -P 6 -I{} sh -c '"$0" "$1/{}" > "$2/$(basename {} | sed "s/\.[^.]*$//").json"' "$BIN" "$FRAMES" "$CACHE"

echo "缓存 $(ls "$CACHE" | wc -l | tr -d ' ') 帧 → $CACHE"
