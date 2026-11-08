#!/usr/bin/env bash
set -euo pipefail
keychain_directory="$(mktemp -d "${RUNNER_TEMP:-$TMPDIR}/tia-keychain.XXXXXXXX")"
keychain_directory="$(cd "$keychain_directory" && pwd -P)"
keychain_file="$keychain_directory/test.keychain-db"
keychain_password='temporary-test-password'
previous_keychain="$(security default-keychain -d user | tr -d '"' | xargs)"
previous_search_list=()
while IFS= read -r keychain; do
  previous_search_list+=("$(printf '%s' "$keychain" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')")
done < <(security list-keychains -d user)
cleanup_keychain() {
  security list-keychains -d user -s "${previous_search_list[@]}"
  security default-keychain -d user -s "$previous_keychain"
  security delete-keychain "$keychain_file" || true
  rm -rf "$keychain_directory"
}
trap cleanup_keychain EXIT
security create-keychain -p "$keychain_password" "$keychain_file"
security unlock-keychain -p "$keychain_password" "$keychain_file"
security set-keychain-settings -lut 3600 "$keychain_file"
security default-keychain -d user -s "$keychain_file"
security list-keychains -d user -s "$keychain_file"
security add-generic-password -a 'tia-launcher' -s 'tia-launcher Safe Storage' -w 'isolated-keychain-password' -A "$keychain_file"
security find-generic-password -a 'tia-launcher' -s 'tia-launcher Safe Storage' -w "$keychain_file" >/dev/null
security find-generic-password -a 'tia-launcher' -s 'tia-launcher Safe Storage' -w >/dev/null
mkdir -p release-test/mac
node_modules/.bin/esbuild migration/tests/electron-key-recovery.cjs --bundle --platform=node --target=node24 --external:electron --outfile=release-test/mac/electron-key-recovery.cjs
node_modules/.bin/electron release-test/mac/electron-key-recovery.cjs src-tauri/target/debug/tia-migration-helper
