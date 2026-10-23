#!/bin/bash
# Build Reactor.icns from icon_1024.png.
# Standard Apple iconset names cover 16, 32, 64, 128, 256, 512 and 1024 px.

set -euo pipefail
cd "$(dirname "$0")"

SRC="icon_1024.png"
SET="Reactor.iconset"

[ -f "$SRC" ] || { echo "missing $SRC — run: swift make_icon.swift" >&2; exit 1; }

rm -rf "$SET"
mkdir "$SET"

make () {  # make <pixels> <filename>
  sips -z "$1" "$1" "$SRC" --out "$SET/$2" >/dev/null
}

make 16   icon_16x16.png
make 32   icon_16x16@2x.png
make 32   icon_32x32.png
make 64   icon_32x32@2x.png
make 128  icon_128x128.png
make 256  icon_128x128@2x.png
make 256  icon_256x256.png
make 512  icon_256x256@2x.png
make 512  icon_512x512.png
make 1024 icon_512x512@2x.png

iconutil -c icns "$SET" -o Reactor.icns

echo "iconset:"
for f in "$SET"/*.png; do
  printf '  %-24s %s\n' "$(basename "$f")" "$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2"px"}')"
done
echo "built Reactor.icns ($(stat -f%z Reactor.icns) bytes)"
