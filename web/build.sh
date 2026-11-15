#!/usr/bin/env bash
# Builds the iPhone web app into web/dist: `ym` for WebAssembly with threads, the data folder as
# one pack, and the static files. Serve dist/ over HTTPS (GitHub Pages: .github/workflows/web.yml).
#   web/build.sh            release build
#   YM_WEB_SKIP_CARGO=1     reuse the last ym.wasm (for page-only changes)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
target_dir="${CARGO_TARGET_DIR:-$root/target}"
dist="$here/dist"
if [ -z "${YM_WEB_SKIP_CARGO:-}" ]; then
  rustup target add wasm32-wasip1-threads >/dev/null
  (cd "$root" && cargo build --release -p ym-cli --target wasm32-wasip1-threads)
fi
rm -rf "$dist"; mkdir -p "$dist/src"
cp "$target_dir/wasm32-wasip1-threads/release/ym.wasm" "$dist/ym.wasm"
node "$here/tools/pack.mjs" "$root/data" /data "$dist/data.pack"
cp "$here"/index.html "$here"/app.js "$here"/styles.css "$here"/manifest.webmanifest "$here"/icon-*.png "$dist/"
cp "$here"/src/*.js "$dist/src/"
version="$(cd "$root" && git rev-parse --short HEAD 2>/dev/null || date +%s)-$(sha256sum "$dist/ym.wasm" "$dist/data.pack" | sha256sum | cut -c1-8)"
sed "s/__VERSION__/$version/" "$here/sw.js" > "$dist/sw.js"
touch "$dist/.nojekyll"
echo "web/dist ready ($version): $(du -sh "$dist" | cut -f1)"
