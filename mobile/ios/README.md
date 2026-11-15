# Yellowmoon for iPhone

An iOS 17+ preview for the Windows fork. Open one Sony `.ARW` from Files,
compare Signature and Neutral, adjust exposure, and share a JPEG or save it
through the share sheet. The Rust engine develops the original RAW on-device.
The app does not send photos to a server or modify the source file.

The preview is 1280 px on its long edge and JPEG export is up to 4096 px. The
initial safety limits are 36 megapixels and 128 MiB per input; the 33 MP Sony
a7C II is in scope, while most full-size a7R files exceed this limit. Keep the
app open during processing. This CPU build needs testing on actual iPhones
for memory, speed, and thermals. Desktop node editing, batch processing, and
non-Sony RAW formats are outside this preview.

## Build and run

Use a Mac with Xcode and an installed iOS simulator, Rustup (the repository
pins Rust), Homebrew, XcodeGen (`brew install xcodegen`), Python 3, and
`cargo-about` 0.9.2 (`cargo install --locked cargo-about --version 0.9.2`).

From the repository root:

```sh
mobile/ios/prepare.sh simulator
open mobile/ios/Yellowmoon.xcodeproj
```

Select an iPhone simulator and Run in Xcode. To test on hardware, run
`mobile/ios/prepare.sh device`, then select a development team in Signing &
Capabilities and choose your connected iPhone. Change the bundle ID if the
account requires a unique ID. This is a source preview; it is not signed for
App Store or TestFlight distribution.

`cargo test --locked -p ym-mobile` renders a synthetic Sony RAW through the
shared bridge and checks that the source was not modified. The iPhone workflow
builds and launches on a simulator; import and share should be checked on a
real iPhone before release.
