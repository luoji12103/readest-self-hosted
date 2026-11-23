#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

workflow=.github/workflows/build-selfhost-android-arm64.yml

if [ ! -f "$workflow" ]; then
  echo "Missing Android arm64 validation workflow: $workflow" >&2
  exit 1
fi

require_marker() {
  local marker="$1"
  if ! rg -Fq -- "$marker" "$workflow"; then
    echo "Missing Android arm64 workflow marker: $marker" >&2
    exit 1
  fi
}

# These markers intentionally include GitHub expressions and shell variables.
# shellcheck disable=SC2016
for marker in \
  'workflow_dispatch:' \
  'release_version:' \
  'contents: read' \
  'aarch64-linux-android' \
  'pnpm patch-tauri-selfhost' \
  'pnpm tauri android init' \
  'python3 ../../scripts/configure-selfhost-android-gradle.py src-tauri/gen/android/app/build.gradle.kts' \
  'pnpm tauri android build -t aarch64 --apk' \
  'arm64-v8a' \
  'SELFHOST_PRODUCT_NAME: My Readest' \
  'SELFHOST_APP_IDENTIFIER: com.readest.selfhost' \
  'SELFHOST_ANDROID_VERSION: 0.11.21-selfhost.1' \
  'SELFHOST_ANDROID_VERSION_CODE: 11021' \
  'SELFHOST_ANDROID_CERT_SHA256: 903bf29bdf76ec24766e48eb8eafc0f0d228572be347008956b3f6aa63d753be' \
  'apksigner sign' \
  'apksigner verify --verbose --print-certs' \
  'bash "$GITHUB_WORKSPACE/scripts/extract-android-certificate-sha256.sh"' \
  'aapt dump badging' \
  'Readest-Selfhost_${version}_arm64.apk' \
  'SHA256SUMS.txt' \
  'apk-audit.txt' \
  'actions/upload-artifact@' \
  'name: selfhost-android-arm64-${{ inputs.release_version }}' \
  'retention-days: 14'
do
  require_marker "$marker"
done

for forbidden in \
  'matrix:' \
  'release:' \
  'gh release' \
  'release create' \
  'windows-latest' \
  'macos-latest' \
  'universal-apple-darwin' \
  'x86_64-pc-windows-msvc' \
  'aarch64-pc-windows-msvc' \
  'armv7-linux-androideabi' \
  'i686-linux-android' \
  'x86_64-linux-android' \
  'pnpm tauri android build --apk' \
  'pnpm tauri android build --split-per-abi --apk'
do
  if rg -Fq -- "$forbidden" "$workflow"; then
    echo "Android arm64 validation workflow contains forbidden marker: $forbidden" >&2
    exit 1
  fi
done

python3 - <<'PY'
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

text = Path('.github/workflows/build-selfhost-android-arm64.yml').read_text()
release = Path('.github/workflows/build-selfhost.yml').read_text().split('\n  build-android:\n', 1)[1]
if 'python3 ../../scripts/configure-selfhost-android-gradle.py src-tauri/gen/android/app/build.gradle.kts' not in release:
    raise SystemExit('Android release job does not use the shared Gradle setup')

with TemporaryDirectory() as temp:
    generated = Path(temp) / 'build.gradle.kts'
    generated.write_text('''android {
    namespace = "com.readest.selfhost"
    defaultConfig {
        applicationId = "com.readest.selfhost"
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
''')
    subprocess.run(['python3', 'scripts/configure-selfhost-android-gradle.py', str(generated)], check=True)
    gradle = generated.read_text()

for required in (
    'namespace = "com.readest.selfhost"',
    'applicationId = "com.readest.selfhost"',
    'val storeFlavor = project.findProperty("storeFlavor")?.toString() ?: "foss"',
    'missingDimensionStrategy("store", storeFlavor)',
    'val penFlavor = project.findProperty("penFlavor")?.toString() ?: "genericPen"',
    'missingDimensionStrategy("pen", penFlavor)',
    'create("selfhostRelease")',
    'signingConfig = signingConfigs.getByName("selfhostRelease")',
    'System.getenv("ANDROID_KEY_ALIAS")',
    'System.getenv("ANDROID_KEY_PASSWORD")',
    'storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: error("ANDROID_KEYSTORE_PATH is required"))',
    'System.getenv("ANDROID_KEYSTORE_PASSWORD")',
):
    if required not in gradle:
        raise SystemExit(f'Android Gradle setup does not preserve {required}')

job_start = text.index('  build-android-arm64:')
steps_start = text.index('    steps:', job_start)
if '${{ secrets.' in text[job_start:steps_start]:
    raise SystemExit('Android arm64 workflow exposes secrets at job scope')

upload_start = text.index('      - name: Upload signed Android arm64 artifact')
upload_block = text[upload_start:]
for required_path in (
    'Readest-Selfhost_${version}_arm64.apk',
    'SHA256SUMS.txt',
    'apk-audit.txt',
):
    if required_path not in text:
        raise SystemExit(f'Android arm64 artifact is missing {required_path}')
if 'dist/selfhost/android/*' in upload_block:
    raise SystemExit('Android arm64 workflow uploads an unrestricted artifact directory')
PY

echo "Selfhost Android arm64 workflow contract tests passed."
