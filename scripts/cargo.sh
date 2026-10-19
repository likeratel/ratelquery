#!/bin/sh
# Cargo wrapper used by `tauri dev` on macOS (see src-tauri/tauri.macos.conf.json).
#
# Development builds are ad-hoc signed, so every rebuild looks like a new app to the keychain and
# "Always allow" on a saved password stops working after the next build. `tauri dev` runs
# `cargo run`, which would start the binary before anything could sign it, so this wrapper turns
# `run` into `build`, signs the result with a stable local identity, then starts it.
#
# Which identity: RATELQUERY_DEV_SIGN_IDENTITY when set; otherwise the only code-signing identity
# in the keychain. With zero or several identities nothing is signed, so a clone never silently
# picks a certificate its owner did not choose. RATELQUERY_DEV_SIGN=0 turns signing off.
set -eu

if [ "${1:-}" != "run" ] || [ "${RATELQUERY_DEV_SIGN:-1}" = "0" ]; then
  exec cargo "$@"
fi
shift

# Split cargo flags (before `--`) from the arguments meant for the binary (after `--`).
build_args=""
profile="debug"
target=""
expect_target=0
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  case "$1" in
    --release) profile="release" ;;
    --target) expect_target=1 ;;
    --target=*) target="${1#--target=}" ;;
    *) if [ "$expect_target" = 1 ]; then target="$1"; expect_target=0; fi ;;
  esac
  build_args="$build_args $1"
  shift
done

# shellcheck disable=SC2086
cargo build $build_args

root=$(cd "$(dirname "$0")/.." && pwd)
target_dir="${CARGO_TARGET_DIR:-$root/src-tauri/target}"
if [ -n "$target" ]; then
  binary="$target_dir/$target/$profile/ratelquery"
else
  binary="$target_dir/$profile/ratelquery"
fi

identity="${RATELQUERY_DEV_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identities=$(security find-identity -v -p codesigning 2>/dev/null | grep -c '^ *[0-9]*) ' || true)
  if [ "$identities" = "1" ]; then
    identity=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NR==1 { print $2 }')
  elif [ "$identities" = "0" ]; then
    echo "dev-sign: no code-signing identity found, leaving the ad-hoc signature" >&2
  else
    echo "dev-sign: $identities identities found; set RATELQUERY_DEV_SIGN_IDENTITY to pick one" >&2
  fi
fi

if [ -n "$identity" ]; then
  if codesign --force --sign "$identity" --identifier dev.harry.ratelquery "$binary" 2>/dev/null; then
    echo "dev-sign: signed as \"$identity\"" >&2
  else
    echo "dev-sign: signing failed, leaving the ad-hoc signature" >&2
  fi
fi

exec "$binary" "$@"
