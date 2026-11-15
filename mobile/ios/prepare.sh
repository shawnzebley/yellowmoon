#!/usr/bin/env bash
# Prepare the project and the Rust archive for the selected Xcode SDK.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "${1:-simulator}" in
  simulator)
    sdk=iphonesimulator
    case "$(uname -m)" in
      arm64) target=aarch64-apple-ios-sim ;;
      x86_64) target=x86_64-apple-ios ;;
      *) echo "Use a Mac with Xcode." >&2; exit 2 ;;
    esac
    ;;
  device) sdk=iphoneos; target=aarch64-apple-ios ;;
  *) echo "Usage: $0 [simulator|device]" >&2; exit 2 ;;
esac
cd "$repo"
export SDKROOT="$(xcrun --sdk "$sdk" --show-sdk-path)"
export IPHONEOS_DEPLOYMENT_TARGET=17.0
export CARGO_TARGET_DIR="$repo/target"
rustup target add "$target"
cargo build --locked --release -p ym-mobile --target "$target"
mkdir -p "$here/.build/$sdk" "$here/.build/Resources"
cp "$repo/target/$target/release/libym_mobile.a" "$here/.build/$sdk/"
rsync -a --delete "$repo/data/" "$here/.build/Resources/data/"
cp LICENSE NOTICE "$here/.build/Resources/"
cd "$here"
xcodegen generate
