#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$repo_root"
node_modules/.bin/tauri build --target universal-apple-darwin --features migration-test --bundles app --ci \
  --config src-tauri/tauri.macos.conf.json --config '{"bundle":{"macOS":{"signingIdentity":null}}}'
bundle_root="$repo_root/src-tauri/target/universal-apple-darwin/release/bundle"
app_bundle="$(find "$bundle_root/macos" -maxdepth 1 -name '*.app' -type d -print -quit)"
test -n "$app_bundle"
/usr/bin/xattr -cr "$app_bundle"
/usr/bin/codesign --force --deep --options runtime --timestamp=none --sign - "$app_bundle"
/usr/bin/codesign --verify --deep --strict "$app_bundle"
/usr/bin/lipo "$app_bundle/Contents/MacOS/tia-launcher" -verify_arch arm64 x86_64
stage="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tia-dmg.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
/usr/bin/ditto "$app_bundle" "$stage/$(basename "$app_bundle")"
ln -s /Applications "$stage/Applications"
mkdir -p "$bundle_root/dmg"
version="$(node -p 'require("./package.json").version')"
image="$bundle_root/dmg/Tia-Launcher-$version-mac-universal.dmg"
/usr/bin/hdiutil create -volname 'Tia Launcher' -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$image"
/usr/bin/codesign --force --timestamp=none --sign - "$image"
/usr/bin/codesign --verify --strict "$image"
/usr/bin/hdiutil verify "$image"
