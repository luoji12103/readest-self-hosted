# Check the `selfhost-v0.11.20` updater against a new selfhost release

From the repository root, with the locked pnpm dependencies installed:

```sh
git fetch --no-tags origin tag selfhost-v0.11.20  # only if the old tag is missing
node --test scripts/test-selfhost-legacy-updater.mjs
```

In a shallow CI checkout, fetch that specific tag or use `fetch-depth: 0` with tags available. The script also needs `tar` and `rustc` on `PATH`. It only asks `rustc` for target metadata, so the Android target libraries and Android SDK are unnecessary. The two public Tauri plugin archives come from crates.io and are checked against the old tag's `Cargo.lock` before extraction. For offline runs, set `SELFHOST_LEGACY_CRATE_DIR` to a directory containing `tauri-plugin-os-2.3.2.crate` and `tauri-plugin-updater-2.10.1.crate`.

The fixture uses the checked-out app's release version and the current `prepare-selfhost-release.mjs`. Its packages are small files with per-file `.sig` markers. The test runs the old `updater.ts`, `UpdaterWindow.tsx`, `androidUpdatePlatform.ts`, and `NativeAppService` with React and the old plugin guest JavaScript. It supplies the generated `latest.json` in place of an HTTP response. Tests record calls at the HTTP, download, and native IPC boundaries.

| Old client | Result covered by the test |
| --- | --- |
| Android ARM64 and x86_64 | Native architecture values `aarch64` and `x86_64` select the matching ARM64 and x64 APKs. |
| Android ARMv7 and x86 | Native architecture values `arm` and `x86` both select the universal APK. Passing the old helper's aliases `armv7` and `i686` instead selects the ARMv7 and x86 APKs. Removing the matching ARM64 entry falls back to universal; removing universal for `arm` gives no update. |
| Windows portable x64 and ARM64 | The old check delegates to Tauri. The window uses the respective `-portable` entry for the download. |
| Windows NSIS x64 and ARM64 | Both old JS entry points delegate without a target. The manifest has `windows-{arch}-nsis` and `windows-{arch}` entries with the same installer URL and signature. |
| macOS Intel and ARM64 | Both old JS entry points delegate without a target. The `darwin-{arch}-app` and `darwin-{arch}` entries point to the same signed universal `.app.tar.gz` rather than the distribution DMG. |
| Linux AppImage x86_64 and ARM64 | The old check delegates to Tauri. The window fetches the matching `-appimage` entry. The bundle-specific and fallback entries contain the same URL and signature. |
| Linux DEB and RPM x86_64 and ARM64 | The old Rust policy disables the in-app updater, and the old JS service honors that native response. The manifest separately supplies the matching `-deb` and `-rpm` entries for release packaging. |

The source for the native behavior is pinned by `selfhost-v0.11.20`:

- [`tauri-plugin-os` 2.3.2 `src/lib.rs`](https://docs.rs/crate/tauri-plugin-os/2.3.2/source/src/lib.rs), lines 81–84 and 123–125, reads `std::env::consts::ARCH` and exposes it to its [guest JS](https://docs.rs/crate/tauri-plugin-os/2.3.2/source/guest-js/index.ts) at lines 128–139. The test checks those target architecture values with `rustc --print cfg --target ...`. The tag's `build-selfhost.yml` checks that the universal APK contains all four ABIs (lines 725–729).
- [`tauri-plugin-updater` 2.10.1 `src/commands.rs`](https://docs.rs/crate/tauri-plugin-updater/2.10.1/source/src/commands.rs), lines 35–62, sets a target only when one is provided. Its [`src/updater.rs`](https://docs.rs/crate/tauri-plugin-updater/2.10.1/source/src/updater.rs), lines 535–598, tries `{os}-{arch}-{installer}` then `{os}-{arch}`, taking both URL and signature from the matching entry. Lines 59–69 and 1324–1349 establish the installer suffixes and OS/architecture strings. The [Tauri submodule pinned by the tag](https://github.com/readest/tauri/blob/6914700e04bfc391a2adfa9c3393a2afe376c154/crates/tauri-utils/src/platform.rs#L353-L369) supplies the bundle type, including `App` for macOS and `None` for an unmarked Windows executable.
- The tag's `apps/readest-app/src-tauri/src/lib.rs`, lines 251–280 and 478–479, disables the in-app updater for non-AppImage Linux packages and registers the default desktop plugin. The test also checks that the old JS and Rust endpoints agree and the old updater public key remains the same in the current Rust config.

Stable custom paths (APK, portable, AppImage) in this old window use the selected URL without passing the manifest signature to its JS verification bridge. The optional old nightly setting actually points to the selfhost stable feed; a separate test observes the selected signature and public key passed to that bridge. The native desktop updater verifies the signature during download (`src/updater.rs`, line 712). Native selection and verification are covered by source review and exact manifest entry assertions; the harness does not run native updater code, verify cryptographic signatures, fetch published packages, or install anything.
