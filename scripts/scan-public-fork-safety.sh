#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

python3 - <<'PY'
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path.cwd()
tracked_files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def read_text(path: str) -> str:
    full_path = ROOT / path
    if not full_path.is_file():
        return ""
    try:
        return full_path.read_text(encoding="utf-8", errors="ignore")
    except FileNotFoundError:
        return ""


def workflow_events(workflow: str) -> set[str]:
    block = re.search(r"(?ms)^on:[ \t]*\n(.*?)(?=^\S|\Z)", workflow)
    return set(re.findall(r"(?m)^  ([a-z_]+):", block.group(1))) if block else set()


allowed_env_files = {
    "apps/readest-app/.env",
    "apps/readest-app/.env.tauri",
    "apps/readest-app/.env.web",
    "apps/readest-app/.env.local.example",
    "apps/readest-app/.env.tauri.example",
    "apps/readest-app/.env.web.example",
    "docker/.env.example",
}

secret_suffixes = (
    ".pem",
    ".key",
    ".p8",
    ".p12",
    ".jks",
    ".keystore",
    ".mobileprovision",
)

for path in tracked_files:
    name = Path(path).name
    lower = path.lower()
    if name.startswith(".env") and path not in allowed_env_files:
        fail(f"tracked env file is not allowed: {path}")
    if lower.endswith(secret_suffixes):
        fail(f"tracked signing/key material is not allowed: {path}")

selfhost_paths = [
    "apps/readest-app/src/services/customServerConfig.ts",
    "apps/readest-app/src/__tests__/services/customServerConfig.test.ts",
    "apps/readest-app/src/__tests__/services/selfhostUpdaterConfig.test.ts",
    "apps/readest-app/src/services/constants.ts",
    "apps/readest-app/src-tauri/tauri.conf.json",
    "apps/readest-app/scripts/patch-tauri-selfhost.mjs",
    "apps/readest.koplugin/readest_selfupdate.lua",
    "docs/selfhost-client.md",
    ".github/workflows/build-selfhost.yml",
    ".github/workflows/build-selfhost-android-arm64.yml",
    ".github/workflows/release-selfhost.yml",
    ".github/workflows/backfill-selfhost-releases.yml",
    ".github/workflows/sync-upstream.yml",
    ".github/workflows/selfhost-safety.yml",
    "scripts/prepare-upstream-candidate.sh",
]
selfhost_paths = [path for path in selfhost_paths if (ROOT / path).exists()]

official_updater_patterns = [
    "https://download.readest.com/releases/latest.json",
    "https://github.com/readest/readest/releases/latest/download/latest.json",
]

for path in selfhost_paths:
    text = read_text(path)
    for pattern in official_updater_patterns:
        if pattern in text:
            fail(f"official updater endpoint found in {path}: {pattern}")

selfhost_updater_file = (
    "https://github.com/luoji12103/readest-self-hosted/"
    "releases/latest/download/latest.json"
)
constants_text = read_text("apps/readest-app/src/services/constants.ts")
if selfhost_updater_file not in constants_text:
    fail("TypeScript updater configuration does not point to the selfhost release manifest")
if "READEST_NIGHTLY_UPDATER_FILE = READEST_UPDATER_FILE" not in constants_text:
    fail("selfhost nightly-channel checks are not constrained to the fork release manifest")

koplugin_updater = read_text("apps/readest.koplugin/readest_selfupdate.lua")
for official_release_host in (
    "https://download.readest.com/releases",
    "https://github.com/readest/readest/releases",
):
    if official_release_host in koplugin_updater:
        fail(f"KOReader self-update still points to official Readest: {official_release_host}")
if "local SelfUpdate = { enabled = false }" not in koplugin_updater:
    fail("KOReader self-update is not explicitly disabled in the selfhost fork")

tauri_config_path = ROOT / "apps/readest-app/src-tauri/tauri.conf.json"
if tauri_config_path.exists():
    config = json.loads(tauri_config_path.read_text(encoding="utf-8"))
    updater = config.get("plugins", {}).get("updater", {})
    endpoints = updater.get("endpoints", [])
    if not updater.get("pubkey"):
        fail("Tauri updater public key is missing")
    if not endpoints:
        fail("Tauri updater endpoint is missing")
    for endpoint in endpoints:
        if "github.com/readest/readest/" in endpoint or "download.readest.com/releases" in endpoint:
            fail(f"Tauri updater endpoint points to official Readest: {endpoint}")

sync_workflow = read_text(".github/workflows/sync-upstream.yml")
sync_helper = read_text("scripts/prepare-upstream-candidate.sh")
if workflow_events(sync_workflow) != {"workflow_dispatch", "schedule"}:
    fail("stable sync must only run on its schedule or by manual dispatch")
sync_permissions = re.search(r"(?ms)^permissions:[ \t]*\n(.*?)(?=^\S|\Z)", sync_workflow)
if (
    not sync_permissions
    or sync_permissions.group(1).strip() != "contents: read"
    or len(re.findall(r"(?m)^\s*permissions\s*:", sync_workflow)) != 1
):
    fail("stable sync must use only contents: read, with no job permission overrides")
if not re.search(r"(?m)^\s+persist-credentials:\s*false\s*$", sync_workflow):
    fail("stable sync must not persist checkout credentials")

sync_forbidden_patterns = (
    (r"\bgit\s+(?:[^\n;|&]*?\s+)?(?:push|tag|rebase)\b|--force-with-lease", "Git push, tag, or rebase command"),
    (r"\bgh\s+|/dispatches\b", "GitHub CLI or workflow dispatch call"),
    (r"\b(?:GH_TOKEN|GITHUB_TOKEN)\b|github\.token\b|\bsecrets\.", "explicit token or secret"),
    (r"\bselfhost-main\b|\brefs/tags/selfhost-", "retired branch or release ref"),
)
for path, text in (("sync-upstream.yml", sync_workflow), ("prepare-upstream-candidate.sh", sync_helper)):
    for pattern, description in sync_forbidden_patterns:
        if re.search(pattern, text):
            fail(f"{path} must not contain a {description}")

sync_actions = re.findall(r"(?m)^\s*(?:-\s*)?uses:\s*(\S+)", sync_workflow)
allowed_sync_actions = {
    "actions/checkout",
    "actions/setup-node",
    "actions-rust-lang/setup-rust-toolchain",
    "pnpm/action-setup",
}
for action in sync_actions:
    name, sep, revision = action.partition("@")
    if name not in allowed_sync_actions or not sep or not re.fullmatch(r"[0-9a-f]{40}", revision):
        fail(f"stable sync uses an unexpected or unpinned action: {action}")

build_workflow = read_text(".github/workflows/build-selfhost.yml")
if "push" in workflow_events(build_workflow):
    fail("build-selfhost must not run independently for selfhost tag pushes")

selfhost_release = read_text(".github/workflows/release-selfhost.yml")
if workflow_events(selfhost_release) != {"workflow_dispatch"}:
    fail("release-selfhost must only run by manual dispatch")

official_release = read_text(".github/workflows/release.yml")
get_release_block = official_release.split("  update-release:", 1)[0]
if "if: github.repository == 'readest/readest'" not in get_release_block:
    fail("official Readest release workflow is not guarded from running in the fork")

nightly_workflow = read_text(".github/workflows/nightly.yml")
for job_name in ("compute-version", "build", "assemble-manifest"):
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        nightly_workflow,
    )
    if not match or "github.repository == 'readest/readest'" not in match.group(1):
        fail(f"official nightly job is not guarded in the fork: {job_name}")

upload_r2_workflow = read_text(".github/workflows/upload-to-r2.yml")
upload_r2_match = re.search(
    r"(?ms)^  upload-to-r2:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
    upload_r2_workflow,
)
if not upload_r2_match or "if: github.repository == 'readest/readest'" not in upload_r2_match.group(1):
    fail("official R2 release upload job is not guarded in the fork")

for path in ("nix-build.yml", "nix-deps-check.yml", "nix-update-inputs.yml"):
    workflow = read_text(f".github/workflows/{path}")
    job_blocks = re.findall(
        r"(?ms)^  ([a-zA-Z0-9_-]+):\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        workflow.partition("\njobs:\n")[2],
    )
    if not job_blocks:
        fail(f"official Nix workflow is missing or contains no jobs: {path}")
    for job_name, job in job_blocks:
        if not re.search(r"(?m)^    if: github\.repository == 'readest/readest'[ \t]*$", job):
            fail(f"official Nix job is not guarded in the fork: {path}:{job_name}")

url_scan_paths = [
    "apps/readest-app/src/services/customServerConfig.ts",
    "apps/readest-app/src/components/settings/ServerSettingsPanel.tsx",
    "apps/readest-app/src/__tests__/services/customServerConfig.test.ts",
    "apps/readest-app/src/__tests__/components/ServerSettingsPanel.test.tsx",
    "apps/readest-app/scripts/patch-tauri-selfhost.mjs",
    "docs/selfhost-client.md",
    ".github/workflows/build-selfhost.yml",
    ".github/workflows/build-selfhost-android-arm64.yml",
    ".github/workflows/release-selfhost.yml",
    ".github/workflows/backfill-selfhost-releases.yml",
    ".github/workflows/sync-upstream.yml",
    ".github/workflows/selfhost-safety.yml",
    "scripts/prepare-upstream-candidate.sh",
]
url_re = re.compile(r"https?://[^\s\"'<>)]*")


def allowed_host(host: str) -> bool:
    host = host.lower().strip("[]")
    if not host:
        return True
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    if re.match(r"^(10|127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$", host):
        return True
    if re.match(r"^192\.168\.\d{1,3}\.\d{1,3}$", host):
        return True
    allowed_exact = {"github.com", "readest.com", "example.com", "example.invalid"}
    if host in allowed_exact:
        return True
    allowed_suffixes = (
        ".github.com",
        ".readest.com",
        ".example.com",
        ".example.invalid",
        ".localhost",
    )
    return host.endswith(allowed_suffixes)


for path in url_scan_paths:
    if not (ROOT / path).exists():
        continue
    for match in url_re.finditer(read_text(path)):
        url = match.group(0).rstrip(".,")
        if "${{" in url:
            continue
        host = urlparse(url).hostname or ""
        if not allowed_host(host):
            fail(f"unexpected hardcoded URL host in {path}: {url}")

dangerous_fields = re.compile(
    r"\b(service_role|jwt_secret|postgres_password|database_url|s3_secret|aws_secret_access_key)\b",
    re.IGNORECASE,
)
dangerous_scan_paths = [
    "apps/readest-app/scripts/patch-tauri-selfhost.mjs",
    ".github/workflows/build-selfhost.yml",
    ".github/workflows/build-selfhost-android-arm64.yml",
    ".github/workflows/release-selfhost.yml",
    ".github/workflows/backfill-selfhost-releases.yml",
    ".github/workflows/sync-upstream.yml",
    ".github/workflows/selfhost-safety.yml",
    "scripts/prepare-upstream-candidate.sh",
]
allowed_dangerous_field_mentions = {"scripts/scan-public-fork-safety.sh"}

for path in dangerous_scan_paths:
    if not (ROOT / path).exists() or path in allowed_dangerous_field_mentions:
        continue
    text = read_text(path)
    match = dangerous_fields.search(text)
    if match:
        fail(f"dangerous server secret field mention in {path}: {match.group(1)}")

private_material_patterns = [
    re.compile(r"BEGIN [A-Z ]*PRIVATE KEY"),
    re.compile(r"untrusted comment:\s*minisign secret key", re.IGNORECASE),
]

for path in tracked_files:
    if path == "scripts/scan-public-fork-safety.sh":
        continue
    text = read_text(path)
    for pattern in private_material_patterns:
        if pattern.search(text):
            fail(f"private key material pattern found in {path}")

if failures:
    print("Public fork safety scan failed:", file=sys.stderr)
    for failure in failures:
        print(f"- {failure}", file=sys.stderr)
    sys.exit(1)

print("Public fork safety scan passed.")
PY
