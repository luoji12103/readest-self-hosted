# Readest Self-hosted Client

This repository packages a self-hosted build of [Readest](https://github.com/readest/readest), an open-source ebook reader for EPUB, PDF, MOBI/KF8, FB2, CBZ, TXT, and synchronized reading across devices.

The goal of this fork is narrow: publish client builds that can connect to a user-operated Readest/Supabase backend instead of the official Readest service. It keeps the upstream reader experience, adds self-host release automation, and publishes signed update metadata from this repository's GitHub Releases.

[中文说明](./docs/README.zh-CN.md)

## What This Fork Provides

- Windows and Android self-host client releases under `selfhost-v*` tags.
- Android APKs split by ABI (`arm64`, `armv7`, `x64`, `x86`) so users do not need the large universal APK.
- Tauri updater metadata in this repository's `latest.json`, separate from the official Readest updater.
- A client-side server switcher for desktop and mobile apps: users can enter their own server URL at runtime.
- Docker/Compose documentation for running the backend stack yourself.

This repository does not run a public Readest service for you. You deploy the backend, then point the client at that backend.

## Downloads

Download self-host client builds from this repository's Releases page:

- [Latest self-host release](https://github.com/luoji12103/readest-self-hosted/releases/latest)
- [All releases](https://github.com/luoji12103/readest-self-hosted/releases)

Android releases are published as separate APKs:

| Asset suffix | Device architecture |
| --- | --- |
| `_arm64.apk` | Most modern Android phones and tablets |
| `_armv7.apk` | Older 32-bit ARM devices |
| `_x64.apk` | x86_64 Android emulators/devices |
| `_x86.apk` | 32-bit x86 Android emulators/devices |

Install the APK matching your device architecture. If unsure, `arm64` is usually correct for modern Android phones.

## Connect the Client to Your Server

In the installed desktop or mobile app:

1. Open the login page or `Settings -> Server`.
2. Enter your server base URL, for example:

   ```text
   https://readest.example.com
   ```

3. Click `Test connection`.
4. Click `Save`.
5. Sign in again. Changing servers clears the local auth session so credentials cannot cross servers.

Do not include `/api` in the server URL. The client derives API requests from the base URL automatically.

More details: [Client self-host configuration](./docs/selfhost-client.md).

## Host the Backend Yourself

The backend stack is documented in [docker/README.md](./docker/README.md). It includes the Readest web client, Supabase-compatible services, PostgREST, Kong, and MinIO/S3-compatible object storage.

Short version:

```bash
cp docker/.env.example docker/.env
# edit docker/.env, especially passwords, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, and public URLs
cd docker
docker compose up -d
```

After deployment, expose the public runtime config endpoint documented in [docs/selfhost-client.md](./docs/selfhost-client.md), then enter your public server URL in the client.

## Build Locally

```bash
git clone https://github.com/luoji12103/readest-self-hosted.git
cd readest-self-hosted
git submodule update --init --recursive
pnpm install
pnpm --filter @readest/readest-app setup-vendors
```

Build desktop:

```bash
cd apps/readest-app
pnpm patch-tauri-selfhost
pnpm tauri build
```

Build Android split APKs:

```bash
cd apps/readest-app
pnpm patch-tauri-selfhost
pnpm tauri android build --split-per-abi --apk
```

The release workflow performs these steps in CI and signs the generated artifacts.

## Release Automation

Self-host releases use tags such as:

```text
selfhost-v0.11.4
```

Maintainers run **Release Selfhost** manually from a reviewed ref. Pushing a self-host tag does not start a release. The release publishes:

- Windows, Linux, and macOS packages and updater signatures
- Android split APKs and signatures
- `latest.json` updater metadata

See [releasing and syncing the fork](./docs/selfhost-client.md#releasing-a-self-host-client) for the maintainer steps.

The updater endpoint defaults to:

```text
https://github.com/luoji12103/readest-self-hosted/releases/latest/download/latest.json
```

## Relationship to Upstream Readest

Readest is developed upstream at [readest/readest](https://github.com/readest/readest). This fork is downstream packaging for self-host users and should stay close to upstream where possible.

The scheduled sync checks a merge candidate against the fork's `main` and reports the result in GitHub Actions. A maintainer reviews and merges upstream changes separately.

When updating this fork, avoid rebuilding older upstream releases with unrelated current source code. Prefer source-equivalent backports for historical self-host releases.

## Security Notes

- Never commit service-role keys, database URLs, JWT secrets, object storage secrets, signing keys, Android keystores, or updater private keys.
- The public runtime config endpoint must only expose client-safe values such as the public API base URL, public Supabase URL, and Supabase anon key.
- Keep signing material in GitHub Actions secrets.

## License

Readest is licensed under the AGPL license. See [LICENSE](./LICENSE).
