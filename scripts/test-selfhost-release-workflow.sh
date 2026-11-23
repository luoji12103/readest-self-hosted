#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

build=.github/workflows/build-selfhost.yml
release=.github/workflows/release-selfhost.yml
safety=.github/workflows/selfhost-safety.yml
android_cert_parser=scripts/extract-android-certificate-sha256.sh

expected_android_cert=903bf29bdf76ec24766e48eb8eafc0f0d228572be347008956b3f6aa63d753be
legacy_apksigner_output="Signer #1 certificate SHA-256 digest: ${expected_android_cert}"
current_apksigner_output="V2 Signer: certificate SHA-256 digest: ${expected_android_cert}"
uppercase_colon_android_cert=$(sed 's/../&:/g; s/:$//' <<< "${expected_android_cert^^}")
current_v3_apksigner_output="V3.0 Signer: certificate SHA-256 digest: ${uppercase_colon_android_cert}"

assert_android_cert_parse() {
  local description="$1"
  local apksigner_output="$2"
  local expected="$3"
  local actual
  actual=$(printf '%s\n' "$apksigner_output" | bash "$android_cert_parser")
  if [ "$actual" != "$expected" ]; then
    echo "Android certificate parser ${description}: got ${actual:-empty}, expected ${expected:-empty}" >&2
    exit 1
  fi
}

for apksigner_output in "$legacy_apksigner_output" "$current_apksigner_output" "$current_v3_apksigner_output"; do
  assert_android_cert_parse "rejected a supported apksigner output format" "$apksigner_output" "$expected_android_cert"
done
assert_android_cert_parse \
  "accepted an unrelated certificate line" \
  "Unrelated certificate SHA-256 digest: ${expected_android_cert}" \
  ""
assert_android_cert_parse \
  "accepted a malformed digest" \
  'V3.0 Signer: certificate SHA-256 digest: not-a-sha256' \
  ""

require_marker() {
  local file="$1"
  local marker="$2"
  if ! rg -Fq -- "$marker" "$file"; then
    echo "Missing release workflow marker in ${file}: ${marker}" >&2
    exit 1
  fi
}

# Release dispatch is explicit; the backfill workflow only reports missing tags.
python3 - <<'PYTHON'
import re
from pathlib import Path

for filename in ('release-selfhost.yml', 'backfill-selfhost-releases.yml'):
    text = (Path('.github/workflows') / filename).read_text()
    events = text.split('\non:\n', 1)[1].split('\npermissions:', 1)[0]
    if re.findall(r'^  ([\w_]+):', events, re.M) != ['workflow_dispatch']:
        raise SystemExit(f'{filename} must only run on manual dispatch')

release = Path('.github/workflows/release-selfhost.yml').read_text()
errors = []
# A run value ends at the next nonblank line at or above the run key's indentation.
lines = release.splitlines()
for index, line in enumerate(lines):
    key = re.match(r' *(?:- +)?(run):', line)
    if not key:
        continue
    script = [line[key.end():]]
    for continuation in lines[index + 1:]:
        if continuation.strip() and len(continuation) - len(continuation.lstrip(' ')) <= key.start(1):
            break
        script.append(continuation)
    if any('${{' in part for part in script):
        errors.append(f'release-selfhost.yml:{index + 1}: run steps must pass GitHub expressions through env')

permissions = re.search(r'(?ms)^permissions:[ \t]*\n(.*?)(?=^\S|\Z)', release)
if not permissions or permissions.group(1).strip() != 'contents: read':
    errors.append('release-selfhost.yml must default to contents: read')

job_permissions = {}
jobs = release.split('\njobs:\n', 1)[1]
for job_name, job in re.findall(r'(?ms)^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)', jobs):
    grant = re.search(r'(?ms)^    permissions:(.*?)(?=^ {4}\S|\Z)', job)
    if grant:
        job_permissions[job_name] = grant.group(1).strip()
if job_permissions != {'publish': 'contents: write'}:
    errors.append('Only the publish job may override release-selfhost.yml permissions with contents: write')

if errors:
    raise SystemExit('\n'.join(errors))

backfill = Path('.github/workflows/backfill-selfhost-releases.yml').read_text()
if not re.search(r'^permissions:\n  contents: read\n\s*\njobs:', backfill, re.M):
    raise SystemExit('The backfill report must have read-only permissions')
if 'GITHUB_STEP_SUMMARY' not in backfill or 'contents: write' in backfill or 'actions: write' in backfill:
    raise SystemExit('Backfill must report tags without requesting write access')
if re.search(r'gh\s+workflow\s+run|gh\s+release\s+(create|edit|upload)|git\s+push|prepare-selfhost-backport\.sh', backfill):
    raise SystemExit('Backfill must not publish, prepare tags or dispatch releases')
PYTHON

# These markers intentionally contain literal shell variable references.
# shellcheck disable=SC2016
for marker in \
  'fail-fast: false' \
  'windows-latest' \
  'x86_64-pc-windows-msvc' \
  'aarch64-pc-windows-msvc' \
  'ubuntu-22.04' \
  'ubuntu-22.04-arm' \
  'x86_64-unknown-linux-gnu' \
  'aarch64-unknown-linux-gnu' \
  'macos-latest' \
  'universal-apple-darwin' \
  "APPLE_SIGNING_IDENTITY: '-'" \
  'pnpm tauri android build --apk' \
  'pnpm tauri android build --split-per-abi --apk' \
  'Duplicate Android APKs for ABI' \
  'apksigner sign' \
  '--ks "$ANDROID_KEYSTORE_PATH"' \
  '--ks-key-alias "$ANDROID_KEY_ALIAS"' \
  '--ks-pass env:ANDROID_KEYSTORE_PASSWORD' \
  '--key-pass env:ANDROID_KEY_PASSWORD' \
  '--v4-signing-enabled false' \
  'apksigner verify --verbose --print-certs' \
  'bash "$GITHUB_WORKSPACE/scripts/extract-android-certificate-sha256.sh"' \
  'keytool -exportcert' \
  'aapt dump badging' \
  'SELFHOST_ANDROID_CERT_SHA256: 903bf29bdf76ec24766e48eb8eafc0f0d228572be347008956b3f6aa63d753be' \
  'Android keystore certificate does not match the pinned selfhost certificate' \
  'got ${certificate_digest:-missing}, expected ${SELFHOST_ANDROID_CERT_SHA256}' \
  'Unexpected Android universal ABI set' \
  'Unexpected Android package identifier' \
  'Unexpected Android version' \
  "Readest-Selfhost_\${version}_universal.apk" \
  "Readest-Selfhost_\${version}_x64-portable.exe" \
  "Readest-Selfhost_\${version}_arm64-portable.exe" \
  "Readest-Selfhost_\${version}_universal.dmg" \
  "Readest-Selfhost_\${version}_amd64.AppImage" \
  "Readest-Selfhost_\${version}_aarch64.AppImage"
do
  require_marker "$build" "$marker"
done

python3 - <<'PY'
from pathlib import Path

text = Path('.github/workflows/build-selfhost.yml').read_text()
jobs = ('build-windows', 'build-linux', 'build-macos', 'build-android')
for index, job in enumerate(jobs):
    start = text.index(f'  {job}:')
    following = [text.find(f'  {candidate}:', start + 1) for candidate in jobs[index + 1 :]]
    following = [position for position in following if position != -1]
    end = min(following) if following else len(text)
    block = text[start:end]
    before_steps = block.split('    steps:', 1)[0]
    if '${{ secrets.' in before_steps:
        raise SystemExit(f'{job} exposes GitHub secrets at job scope')
PY

python3 - <<'PY'
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

text = Path('.github/workflows/build-selfhost.yml').read_text()
start = text.index('  build-linux:')
end = text.index('  build-macos:', start)
block = text[start:end]

def step(name):
    return block.split(f'      - name: {name}\n', 1)[1].split('      - name:', 1)[0]

deps = step('Install Linux dependencies')
for package in ('libasound2-dev', 'libclang-dev', 'g++', 'libnss3', 'libpulse0', 'libspeechd2', 'libxkbcommon-x11-0'):
    if package not in deps.split():
        raise SystemExit(f'Linux dependencies are missing {package}')
if 'pkg-config --modversion alsa' not in deps:
    raise SystemExit('Linux setup must check that pkg-config can find ALSA')

install = step('Install the pinned Tauri CEF CLI')
if 'TAURI_CEF_CLI_REV: 6beeb209b5514f597a26f48b7a5b9fe4c59b5f12' not in install or \
   'cargo install tauri-cli --git https://github.com/readest/tauri --rev "$TAURI_CEF_CLI_REV" --locked --force' not in install:
    raise SystemExit('Linux must install the pinned, locked Tauri CEF CLI from Readest')
if 'TAURI_BUNDLER_NEW_APPIMAGE_FORMAT' in block or 'quick-sharun.sh' in block:
    raise SystemExit('The CEF CLI must manage its own pinned quick-sharun helper')

build = step('Build and collect Linux packages')
if '        timeout-minutes: 45' not in build.split('        env:', 1)[0]:
    raise SystemExit('Linux package build is missing its step-level hang timeout')
if "TAURI_CEF_CARGO: '1'" not in build or "STRACE_MODE: '0'" not in build:
    raise SystemExit('Linux must use the Cargo CEF CLI without runtime tracing')
ordered = [build.index(marker) for marker in (
    'pnpm patch-tauri-selfhost', 'pnpm tauri build', '--appimage-extract',
    'verify-selfhost-linux-appimage.sh', 'copy_signed "${appimages[0]}"',
)]
if ordered != sorted(ordered):
    raise SystemExit('Linux must patch its identity, build, extract, verify, and then collect the AppImage')
for asset in (
    'Readest-Selfhost_${version}_amd64.AppImage', 'Readest-Selfhost_${version}_aarch64.AppImage',
    'Readest-Selfhost_${version}_amd64.deb', 'Readest-Selfhost_${version}_arm64.deb',
    'Readest-Selfhost-${version}-1.x86_64.rpm', 'Readest-Selfhost-${version}-1.aarch64.rpm',
):
    if asset not in build:
        raise SystemExit(f'Linux changed the release asset basename {asset}')

with TemporaryDirectory() as directory:
    appdir = Path(directory) / 'My Readest.AppDir'
    executables = ('AppRun', 'bin/readest', 'shared/bin/readest')
    required_files = (
        'bin/libcef.so', 'bin/00-no-userns-prompt.hook', 'lib/libsoftokn3.so',
        'lib/libfreeblpriv3.so', 'lib/libnssckbi.so', 'lib/libsqlite3.so.0',
        'lib/libpulse.so.0', 'lib/libspeechd.so.2', 'lib/libxkbcommon-x11.so.0',
        'lib/pulseaudio/libpulsecommon-15.99.so',
    )
    for name in executables + required_files:
        path = appdir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('payload')
        if name in executables:
            path.chmod(0o755)
    (appdir / 'lib/lib.path').write_text('+\n+/pulseaudio\n')
    (appdir / 'My Readest.desktop').write_text('[Desktop Entry]\nName=My Readest\n')
    command = ['bash', 'scripts/verify-selfhost-linux-appimage.sh', str(appdir), 'My Readest']
    subprocess.run(command, check=True)

    def rejects(message):
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 1 or message not in result.stderr:
            raise SystemExit(f'Linux AppImage verification did not reject {message}: {result.stderr}')

    (appdir / 'lib/lib.path').write_text('+\n+/pulseaudio-extra\n')
    rejects('Missing +/pulseaudio in lib/lib.path')
    (appdir / 'lib/lib.path').write_text('+\n+/pulseaudio\n')
    (appdir / 'lib/libpulse.so.0').unlink()
    (appdir / 'lib/libpulse.so.0').symlink_to('libpulse.so.0.24.1')
    rejects('Missing library libpulse.so.0')
    (appdir / 'lib/libpulse.so.0.24.1').write_text('payload')
    (appdir / 'bin/00-no-userns-prompt.hook').unlink()
    rejects('Missing the no-userns-prompt hook')
PY

python3 - <<'PY'
from pathlib import Path

text = Path('.github/workflows/build-selfhost.yml').read_text()
start = text.index('      - name: Initialize signed Android project')
end = text.index('      - name:', start + 8)
block = text[start:end]
if 'ANDROID_KEYSTORE_BASE64' in block:
    raise SystemExit('Android project initialization still has access to the private keystore')
if 'TAURI_UPDATER_PUBKEY' not in block:
    raise SystemExit('Android project initialization is missing the public updater key')
if '      - name: Decode Android keystore' not in text:
    raise SystemExit('Android keystore does not have a dedicated decode step')
PY

python3 - <<'PY'
from pathlib import Path

text = Path('.github/workflows/build-selfhost.yml').read_text()
start = text.index('      - name: Build Android universal and split APKs')
end = text.index('      - name: Upload Android artifacts', start)
block = text[start:end]

android_sign = block.index('apksigner sign')
android_verify = block.index('apksigner verify --verbose --print-certs')
updater_sign = block.index('pnpm tauri signer sign "$apk"')
if not android_sign < android_verify < updater_sign:
    raise SystemExit('Final APKs must be Android-signed and verified before updater signatures are generated')
if 'pnpm tauri signer sign "$universal_asset"' in block or 'pnpm tauri signer sign "$asset"' in block:
    raise SystemExit('Updater signatures are generated before the final Android APK bytes are available')
PY

for forbidden_apple_secret in \
  APPLE_CERTIFICATE \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_ID \
  APPLE_PASSWORD \
  APPLE_TEAM_ID
do
  if rg -Fq -- "$forbidden_apple_secret" "$build"; then
    echo "Selfhost build workflow must not depend on ${forbidden_apple_secret}" >&2
    exit 1
  fi
done

if sed -n '/^  build-macos:/,/^  build-android:/p' "$build" | rg -q '\bmapfile\b'; then
  echo "macOS selfhost job uses mapfile, which is unavailable in system Bash 3.2" >&2
  exit 1
fi
if sed -n '/^  build-macos:/,/^  build-android:/p' "$build" | rg -q -- '--bundles([=[:space:]]|$)'; then
  echo "macOS selfhost job restricts the configured DMG and app updater bundle targets" >&2
  exit 1
fi
if ! sed -n '/^  build-macos:/,/^  build-android:/p' "$build" |
  rg -q '^[[:space:]]*pnpm tauri build --target universal-apple-darwin[[:space:]]*$'; then
  echo "macOS selfhost job is missing the unrestricted Universal bundle build" >&2
  exit 1
fi

for marker in \
  "group: release-selfhost-\${{ github.repository }}-\${{ github.ref_type == 'tag' && github.ref_name || inputs.tag }}" \
  'cancel-in-progress: false' \
  'needs:' \
  '- build' \
  'scripts/prepare-selfhost-release.mjs' \
  "SELFHOST_RELEASE_PUB_DATE=\$(git show -s --format=%cI \"\$GITHUB_SHA\")" \
  'Existing public releases are immutable' \
  'isPrerelease' \
  '--draft' \
  '--draft=false' \
  '--prerelease=false' \
  '--latest' \
  'diff -u expected-assets.tsv remote-assets.tsv' \
  "gh release upload \"\$release_tag\" release-assets/* --clobber"
do
  require_marker "$release" "$marker"
done

if rg -Fq -- 'release_was_public' "$release"; then
  echo "Release workflow still permits in-place mutation of a public release" >&2
  exit 1
fi

if rg -Fq -- 'const androidPlatforms' "$release"; then
  echo "Release workflow still contains the embedded partial manifest generator" >&2
  exit 1
fi

require_marker "$safety" 'sudo apt-get install -y ripgrep'
require_marker "$safety" 'bash scripts/test-prepare-selfhost-release.sh'
require_marker "$safety" 'bash scripts/test-selfhost-release-workflow.sh'

echo "Selfhost release workflow contract tests passed."
