import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = "apps/readest-app/src-tauri/gen/android/app/build.gradle.kts"

# Tauri init needs a fresh project for the fork's package name. Reuse the
# checked-in app's flavor choices without restoring its upstream namespace.
template = subprocess.check_output(["git", "show", f"HEAD:{TEMPLATE}"], cwd=ROOT, text=True)
start_marker = "        val storeFlavor = "
end_marker = '        missingDimensionStrategy("pen", penFlavor)\n'
if start_marker not in template or end_marker not in template:
    raise SystemExit("Expected Android store/pen flavor defaults in the tracked Gradle template")
start = template.index(start_marker)
end = template.index(end_marker, start) + len(end_marker)

path = Path(sys.argv[1])
text = path.read_text()


def replace_once(source: str, marker: str, replacement: str) -> str:
    if source.count(marker) != 1:
        raise SystemExit(f"Expected one {marker.strip()} in {path}")
    return source.replace(marker, replacement, 1)


text = replace_once(text, "    defaultConfig {\n", "    defaultConfig {\n" + template[start:end])
text = replace_once(
    text,
    "    buildTypes {\n",
    '''    signingConfigs {
        create("selfhostRelease") {
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: error("ANDROID_KEYSTORE_PATH is required"))
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
''',
)
text = replace_once(
    text,
    '        getByName("release") {\n',
    '''        getByName("release") {
            signingConfig = signingConfigs.getByName("selfhostRelease")
''',
)
path.write_text(text)
