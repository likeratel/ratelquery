#!/bin/sh
# Cargo wrapper used by `tauri dev` on macOS (see src-tauri/tauri.macos.conf.json).
#
# Development builds are ad-hoc signed, so every rebuild looks like a new app to the keychain and
# "Always allow" on a saved password stops working after the next build. `tauri dev` runs
# `cargo run`, which would start the binary before anything could sign it, so this wrapper turns
# `run` into `build`, signs the result with a stable local identity, then starts it. With no
# identity available the binary stays ad-hoc signed and behaves exactly like plain cargo.
#
# Set DBCLIENT_DEV_SIGN_IDENTITY to pick an identity, or DBCLIENT_DEV_SIGN=0 to skip signing.
set -eu

if [ "${1:-}" != "run" ] || [ "${DBCLIENT_DEV_SIGN:-1}" = "0" ]; then
  exec cargo "$@"
fi
shift

# Split cargo flags (before `--`) from the arguments meant for the binary (after `--`).
build_args=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  build_args="$build_args $1"
  shift
done

# shellcheck disable=SC2086
cargo build $build_args

root=$(cd "$(dirname "$0")/.." && pwd)
binary="${CARGO_TARGET_DIR:-$root/src-tauri/target}/debug/dbclient"

identity="${DBCLIENT_DEV_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NR==1 { print $2 }')
fi
if [ -n "$identity" ]; then
  if codesign --force --sign "$identity" --identifier dev.harry.dbclient "$binary" 2>/dev/null; then
    echo "dev-sign: signed as \"$identity\"" >&2
  else
    echo "dev-sign: signing failed, leaving the ad-hoc signature" >&2
  fi
else
  echo "dev-sign: no code-signing identity found, leaving the ad-hoc signature" >&2
fi

exec "$binary" "$@"
