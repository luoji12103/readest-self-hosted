#!/usr/bin/env bash
set -euo pipefail

appdir=${1:?Expected the extracted AppImage directory}
product_name=${2:?Expected the product name}
lib="$appdir/lib"

fail() {
  echo "::error::$1 in the AppImage bundle" >&2
  exit 1
}

# The CEF CLI gives quick-sharun a space-free AppDir. Check that it wrapped the main binary.
for executable in AppRun bin/readest shared/bin/readest; do
  [[ -f "$appdir/$executable" && -x "$appdir/$executable" ]] || fail "Missing executable $executable"
done
grep -Fqx "Name=$product_name" "$appdir/$product_name.desktop" || fail "Missing desktop entry for $product_name"
[[ -s "$appdir/bin/libcef.so" ]] || fail 'Missing Chromium runtime libcef.so'

# Chromium and winit dlopen these libraries; a successful build can leave them out.
for so in libsoftokn3.so libfreeblpriv3.so libnssckbi.so libsqlite3.so.0 \
          libpulse.so.0 libspeechd.so.2 libxkbcommon-x11.so.0; do
  [[ -s "$lib/$so" ]] || fail "Missing library $so"
done

# libpulse's private library and its search path must both be present.
pulse_common=("$lib"/pulseaudio/libpulsecommon-*.so)
[[ -s "${pulse_common[0]}" ]] || fail 'Missing libpulsecommon'
grep -Fqx '+/pulseaudio' "$lib/lib.path" || fail 'Missing +/pulseaudio in lib/lib.path'
[[ -s "$appdir/bin/00-no-userns-prompt.hook" ]] || fail 'Missing the no-userns-prompt hook'
