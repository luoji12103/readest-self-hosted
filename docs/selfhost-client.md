# Readest Self-host Client Configuration

Readest desktop and mobile clients can be pointed at a compatible self-hosted backend by entering one public server base URL in the client.

The client does not contain a private backend URL. Each user supplies their own server URL at runtime.

## Server URL

In the desktop or mobile app, open the login page or Settings -> Server, then enter a server base URL such as:

```text
https://your-readest-server.example.com
```

The client normalizes the URL before saving it:

- leading and trailing whitespace is removed
- trailing slashes are removed
- only `http` and `https` URLs are accepted
- production builds require `https`
- development builds may use `http` for localhost, loopback, or local network testing

## Public Runtime Config Discovery

The native client tries these public sources in order:

```text
GET /.well-known/readest-client-config.json
```

then:

```text
GET /api/public/runtime-config
```

and finally:

```text
GET /runtime-config.js
```

The first two sources must return a JSON object. The script source is accepted only when its complete body is one assignment in this form:

```javascript
window.__READEST_RUNTIME_CONFIG = {"apiBaseUrl":"https://your-readest-server.example.com"};
```

The client extracts and parses the JSON object. It never executes the remote script, scans application bundles, or imports a WebUI browser session. Discovery uses Tauri native HTTP in desktop and mobile builds, with an 8-second timeout and a 64 KiB response limit.

Example response:

```json
{
  "apiBaseUrl": "https://your-readest-server.example.com",
  "supabaseUrl": "https://your-supabase-public.example.com",
  "supabaseAnonKey": "your-public-anon-jwt-or-publishable-key"
}
```

Fields:

- `apiBaseUrl`: public base URL for Readest API requests. If omitted, the entered server base URL is used.
- `supabaseUrl`: public Supabase project URL used by the client for authentication and sync.
- `supabaseAnonKey`: a legacy Supabase JWT with role `anon`, or a public key whose prefix is `sb_publishable_`.

Current Readest authentication and sync flows require Supabase client config, so `supabaseUrl` and `supabaseAnonKey` must be present for a saved custom server.

## Public Config Is Not Secret Config

The runtime config endpoint is public client configuration. It must only return values that are safe for an installed app or browser client to see.

Never return server-side secrets from this endpoint, including:

- Supabase `service_role` keys
- JWT signing secrets
- database URLs or database passwords
- S3 or object storage secrets
- AWS secret access keys
- Tauri updater private keys
- Android keystores or signing passwords
- SSH keys or other private keys

The client rejects runtime config responses that contain common dangerous secret field names.

## Official Docker Compatibility Mode

Official Docker Compose WebUI deployments may serve the Readest UI and API without exposing any discovery source. In this case the client automatically expands **Official Docker compatibility** after a failed discovery attempt. The same section can be opened explicitly from Settings -> Server before testing.

Enter these public client values once:

- **Server URL**: the WebUI URL entered in the normal server field.
- **API base URL**: optional; leave it equal to the server URL unless the Readest API is published on a different origin.
- **Supabase public URL**: the public Supabase gateway URL used by the deployed WebUI.
- **Supabase anon or publishable key**: the deployment's browser-safe `anon` JWT or `sb_publishable_` key.

These values are normally available in the deployment's environment file or public WebUI configuration. Do not enter a `service_role` JWT, an `sb_secret_` key, a JWT signing secret, a database password, or another server-side value. The client rejects these values and masks the public key field on screen by default.

**Test connection** and **Save** independently check `${apiBaseUrl}/api/sync` and `${supabaseUrl}/auth/v1/settings`. HTTP 401 or 403 from the Readest API proves the API is reachable; it is not reported as a network error. The Supabase request includes the public key. Timeout, TLS, Readest API, Supabase, URL, incomplete-config, and rejected-secret errors are reported separately, and failed validation does not clear the form.

Username and password are intentionally not accepted in this compatibility form. After the public config is saved, sign in through the normal Readest login screen. The existing credentials are then sent directly to that configured Supabase Auth service, so the account and library remain the same without copying cookies or local storage from the WebUI.

## Session Handling

When the effective server, API, Supabase URL, or Supabase public key changes, the client clears local authentication session data and requires the user to sign in again. Saving an equivalent normalized config does not sign the user out. Resetting an active custom server also clears its session.

## Public Fork Boundary

For public forks and GitHub Actions:

- do not commit real deployment URLs, service keys, database credentials, signing keys, Android keystores, or private updater keys
- keep Tauri updater private keys in GitHub Actions secrets only
- keep Android signing material in GitHub Actions secrets only
- use the fork's public GitHub Releases `latest.json` for updater metadata, not the official Readest updater endpoint

## GitHub Secrets

The self-hosted build and release workflows expect these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_UPDATER_PUBKEY`
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Generate the Tauri updater key pair with the Tauri signer, store the private key and password as secrets, and store only the public key in `TAURI_UPDATER_PUBKEY`.

For Android, base64-encode the keystore file and store that encoded value in `ANDROID_KEYSTORE_BASE64`. The keystore file itself must not be committed.

## Releasing a Self-host Client

Stable selfhost releases use tags such as `selfhost-v0.11.20`. The release workflow builds and audits the complete configured Windows, Linux, macOS, and Android matrix before publishing an immutable GitHub Release and updater `latest.json`.

After review, manually run **Release Selfhost** (`release-selfhost.yml`) against the branch or tag that points to the source commit to package. Set `tag` to the desired selfhost tag. The optional `release_version` defaults to the version in that tag. If the tag already exists, it must point to the selected commit. Pushing a selfhost tag does not trigger the release workflow.

**Backfill Selfhost Releases** lists missing tags for maintainers to review. Both values of `dry_run` only list candidates; the workflow does not create tags or start release builds. Review the source for each historical version before manually releasing it.

The `0.11.21-selfhost.1` compatibility build uses a staged exception: the first workflow run builds only a signed Android arm64 APK and keeps it as a 14-day GitHub Actions artifact for real-device validation. It does not create or modify a public Release. The complete affected matrix and stable/latest Release are built only after that APK is confirmed on a real device.

The default updater URL points at this fork's public GitHub Release metadata:

```text
https://github.com/<fork-owner>/<fork-repo>/releases/latest/download/latest.json
```

Android APKs are published by the workflow. Platform-level automatic app update behavior for sideloaded Android APKs may vary by installation source, so distribute the release URL or APK directly when needed.

## Syncing Upstream

The scheduled or manually dispatched **Check Stable Upstream Candidate** workflow (`sync-upstream.yml`) selects the newest upstream tag of the form `vMAJOR.MINOR.PATCH` and checks that its commit is reachable from `upstream/main`. Prerelease tags and untagged upstream commits are excluded. The fork's only sync base is `origin/main`. The retired `selfhost-main` branch remains at its historical commit.

If `origin/main` already contains the stable commit, the job summary reports that there is nothing to merge. Otherwise the workflow merges the tagged commit into a temporary branch on the runner and checks the client, Lua plugin, Rust code, Web build, release contracts, legacy updater compatibility, and public fork safety. The summary shows the fork base, upstream tag and commit, candidate commit and tree when available, and the result. For a conflict or a failed check, open the corresponding step log.

The temporary branch exists only for that run. To propose the update, recreate the merge of the recorded upstream commit into the recorded fork base on a local review branch, compare its tree with the summary, and open a pull request to `main`. If `main` has moved, recheck the merge against the new base before submitting it. The sync workflow never pushes a branch or tag or starts a release.
