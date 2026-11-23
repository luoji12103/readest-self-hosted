import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = 'apps/readest-app';
const legacyTag = 'selfhost-v0.11.20';
const legacy = (path) =>
  execFileSync('git', ['show', `refs/tags/${legacyTag}:${path}`], { cwd: root, encoding: 'utf8' });
const legacyPackage = JSON.parse(legacy(`${app}/package.json`));
const appRequire = createRequire(join(root, app, 'package.json'));
const { version } = appRequire('./package.json');
const repository = 'luoji12103/readest-self-hosted';
const tag = `selfhost-v${version}`;
const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`;
const assetUrl = (name) =>
  `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
const apk = (arch) => `Readest-Selfhost_${version}_${arch}.apk`;
const windows = (arch, format) => `Readest-Selfhost_${version}_${arch}-${format}.exe`;
const appimage = (arch) => `Readest-Selfhost_${version}_${arch}.AppImage`;
const deb = (arch) => `Readest-Selfhost_${version}_${arch}.deb`;
const rpm = (arch) => `Readest-Selfhost-${version}-1.${arch}.rpm`;
const macUpdate = `Readest-Selfhost_${version}_universal.app.tar.gz`;
const signature = (name) => `test-signature-for-${name}`;

const androidTargets = [
  ['aarch64-linux-android', 'aarch64', 'android-arm64', 'arm64'],
  ['armv7-linux-androideabi', 'arm', 'android-universal', 'universal'],
  ['i686-linux-android', 'x86', 'android-universal', 'universal'],
  ['x86_64-linux-android', 'x86_64', 'android-x86_64', 'x64'],
];
const androidAliases = [
  ['armv7', 'android-armv7', 'armv7'],
  ['i686', 'android-i686', 'x86'],
];
const desktopTargets = [
  ['windows', 'x86_64', 'nsis', windows('x64', 'setup')],
  ['windows', 'aarch64', 'nsis', windows('arm64', 'setup')],
  ['macos', 'x86_64', 'app', macUpdate],
  ['macos', 'aarch64', 'app', macUpdate],
];
const appImages = [
  ['x86_64', appimage('amd64')],
  ['aarch64', appimage('aarch64')],
];
const linuxPackages = [
  ['x86_64', 'deb', deb('amd64')],
  ['aarch64', 'deb', deb('arm64')],
  ['x86_64', 'rpm', rpm('x86_64')],
  ['aarch64', 'rpm', rpm('aarch64')],
];

const fixtureDir = mkdtempSync(join(tmpdir(), 'readest-legacy-updater-'));
after(() => rmSync(fixtureDir, { recursive: true }));
const assetsDir = join(fixtureDir, 'assets');
mkdirSync(assetsDir);
for (const name of new Set([
  ...androidTargets.map(([, , , arch]) => apk(arch)),
  ...androidAliases.map(([, , arch]) => apk(arch)),
  ...desktopTargets.map(([, , , name]) => name),
  ...appImages.map(([, name]) => name),
  ...linuxPackages.map(([, , name]) => name),
  windows('x64', 'portable'),
  windows('arm64', 'portable'),
])) {
  writeFileSync(join(assetsDir, name), `fixture for ${name}\n`);
  writeFileSync(join(assetsDir, `${name}.sig`), `${signature(name)}\n`);
}
writeFileSync(join(assetsDir, `Readest-Selfhost_${version}_universal.dmg`), 'DMG fixture\n');
execFileSync(process.execPath, ['scripts/prepare-selfhost-release.mjs'], {
  cwd: root,
  env: {
    RELEASE_TAG: tag,
    GITHUB_REPOSITORY: repository,
    SELFHOST_RESOLVED_RELEASE_VERSION: version,
    SELFHOST_RELEASE_PUB_DATE: '2026-11-22T00:00:00Z',
    SELFHOST_RELEASE_ASSETS_DIR: assetsDir,
    SELFHOST_RELEASE_NOTES_PATH: join(fixtureDir, 'notes.md'),
  },
});
const manifest = JSON.parse(readFileSync(join(assetsDir, 'latest.json'), 'utf8'));
const assertEntry = (key, asset) =>
  assert.deepEqual(manifest.platforms[key], { url: assetUrl(asset), signature: signature(asset) }, key);

const lock = legacy('Cargo.lock');
async function crate(name, files) {
  const [, version, checksum] = lock.match(new RegExp(
    `name = "${name}"\nversion = "([^"]+)"\nsource = "registry\\+https://github\\.com/rust-lang/crates\\.io-index"\nchecksum = "([a-f0-9]{64})"`,
  ));
  const dir = `${name}-${version}`;
  const archive = `${dir}.crate`;
  const cache = process.env.SELFHOST_LEGACY_CRATE_DIR;
  const bytes = cache
    ? readFileSync(join(cache, archive))
    : await downloadCrate(`https://static.crates.io/crates/${name}/${archive}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum, `${archive} Cargo.lock checksum`);
  // Extract only the published source files that this test reads.
  execFileSync('tar', ['-xz', '-C', fixtureDir, ...files.map((path) => `${dir}/${path}`)], {
    input: bytes,
  });
  return (path) => readFileSync(join(fixtureDir, dir, path), 'utf8');
}

async function downloadCrate(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Could not retrieve ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const [oldOs, oldUpdater] = await Promise.all([
  crate('tauri-plugin-os', ['guest-js/index.ts', 'src/lib.rs']),
  crate('tauri-plugin-updater', ['guest-js/index.ts', 'src/commands.rs', 'src/updater.rs']),
]);
const { transformWithEsbuild } = await import(appRequire.resolve('vite'));
const { JSDOM } = appRequire('jsdom');
const { createElement } = appRequire('react');
const dom = new JSDOM('');
// A local origin enables the old helper's real update-check localStorage behavior.
dom.reconfigure({ url: 'https://readest.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = window.localStorage;
const { act, cleanup, fireEvent, render, screen } = appRequire('@testing-library/react');
afterEach(cleanup);

const oldModules = {
  '@/helpers/updater': 'helpers/updater.ts',
  '@/helpers/androidUpdatePlatform': 'helpers/androidUpdatePlatform.ts',
  '@/components/UpdaterWindow': 'components/UpdaterWindow.tsx',
  '@/services/constants': 'services/constants.ts',
  '@/types/settings': 'types/settings.ts',
  '@/utils/version': 'utils/version.ts',
  'legacy:NativeAppService': 'services/nativeAppService.ts',
};
const sources = {
  ...Object.fromEntries(
    Object.entries(oldModules).map(([id, path]) => [id, [path, legacy(`${app}/src/${path}`)]]),
  ),
  '@tauri-apps/plugin-os': ['plugin-os.ts', oldOs('guest-js/index.ts')],
  '@tauri-apps/plugin-updater': ['plugin-updater.ts', oldUpdater('guest-js/index.ts')],
};
const compiled = new Map(
  await Promise.all(Object.entries(sources).map(async ([id, [path, source]]) => {
    const { code } = await transformWithEsbuild(source, path, { format: 'cjs', jsx: 'automatic' });
    return [id, new Function('require', 'module', 'process', 'setTimeout', 'console', code)];
  })),
);

function client(os, arch, { portable = false, isAppImage = false, disabled = false, data = manifest } = {}) {
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { os_type: os, arch };
  window.__READEST_IS_APPIMAGE = isAppImage;
  localStorage.clear();
  const calls = { fetch: [], native: [], downloads: [], verifies: [], installs: [], windows: [] };
  const fetch = async (url) => {
    if (url === 'https://download.readest.com/releases/release-notes.json') {
      return Response.json({ releases: {} });
    }
    assert.equal(url, endpoint);
    calls.fetch.push(url);
    return Response.json(data);
  };
  const invoke = async (command, args) => {
    switch (command) {
      case 'plugin:updater|check':
        calls.native.push([command, args]);
        // The real guest bridge is running; Rust's response is the IPC boundary.
        return { rid: 1, version: data.version, currentVersion: legacyPackage.version, rawJson: data };
      case 'plugin:updater|download_and_install':
        calls.native.push([command, { rid: args.rid }]);
        return;
      case 'is_updater_disabled':
        calls.native.push([command]);
        return disabled;
      case 'get_executable_dir':
        return '/exec';
      case 'set_webview_info':
        return;
      default:
        assert.fail(`Unexpected native invocation: ${command}`);
    }
  };
  let service;
  const identity = (value) => value;
  const noOp = async () => {};
  const stubs = {
    '../../package.json': legacyPackage,
    '@tauri-apps/api/core': { invoke, Resource: class { constructor(rid) { this.rid = rid; } }, Channel: class {} },
    '@tauri-apps/api/path': { join, desktopDir: async () => '/desktop' },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: class {
        constructor(label, options) { calls.windows.push([label, options]); }
        once() {}
      },
    },
    '@tauri-apps/plugin-http': { fetch },
    '@tauri-apps/plugin-process': { exit: noOp, relaunch: noOp },
    '@tauri-apps/plugin-shell': { Command: { create: () => ({ execute: noOp, spawn: noOp }) } },
    '@/services/environment': { isTauriAppPlatform: () => true },
    '@/context/EnvContext': { useEnv: () => ({ appService: service }) },
    '@/hooks/useTranslation': { useTranslation: () => identity },
    '@/hooks/useTranslator': { useTranslator: () => ({}) },
    '@/utils/misc': { getLocale: () => 'en', stubTranslation: identity },
    '@/utils/config': { getDefaultMaxInlineSize: () => 0, getDefaultMaxBlockSize: () => 0 },
    '@/utils/viewTransition': { detectViewTransitionGroup: () => false, detectViewTransitionsAPI: () => false },
    '@/utils/transfer': {
      tauriDownload: async (url, path, progress) => {
        calls.downloads.push([url, path]);
        progress({ total: 2, progress: 1 });
        progress({ total: 2, progress: 2 });
      },
    },
    '@/utils/bridge': {
      installPackage: async ({ path }) => { calls.installs.push(path); return { success: true }; },
      verifyUpdateSignature: async (...args) => { calls.verifies.push(args); return true; },
    },
    'next/image': () => null,
    'next/navigation': { useSearchParams: () => null },
    '@/components/Dialog': ({ id, isOpen, children }) => createElement('div', { id }, isOpen && children),
    './Link': () => null,
    './appService': { BaseAppService: class {} },
  };
  // These application imports initialize unrelated defaults or are used by
  // filesystem commands outside the paths exercised here.
  const inactiveImports = new Set([
    './ai/constants', './tts/EdgeTTSClient', './tts/TTSController', '@/utils/annotationToolbar',
    '@tauri-apps/plugin-fs', '@tauri-apps/plugin-dialog', '@choochmeque/tauri-plugin-sharekit-api',
    '@/utils/path', '@/utils/file', '@/utils/image', '@/utils/files',
  ]);
  const cache = new Map();
  function load(id) {
    if (id === './constants') return load('@/services/constants');
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (inactiveImports.has(id)) return {};
    if (!compiled.has(id)) return appRequire(id);
    if (!cache.has(id)) {
      const module = { exports: {} };
      cache.set(id, module);
      compiled.get(id)(
        load,
        module,
        { env: { NEXT_PUBLIC_PORTABLE_APP: portable || undefined } },
        queueMicrotask,
        { ...console, log() {} },
      );
    }
    return cache.get(id).exports;
  }
  const { NativeAppService } = load('legacy:NativeAppService');
  service = new NativeAppService();
  service.fs = { exists: async () => false };
  service.loadSettings = async () => ({});
  service.prepareBooksDir = noOp;
  service.runMigrations = noOp;
  service.resolveFilePath = async (name, base) => join('/', base, name);
  const { READEST_UPDATER_FILE, READEST_UPDATER_PUBKEY } = load('@/services/constants');
  const { checkForAppUpdates } = load('@/helpers/updater');
  return {
    service,
    calls,
    ...load('@/components/UpdaterWindow'),
    ...load('@/helpers/androidUpdatePlatform'),
    READEST_UPDATER_FILE,
    READEST_UPDATER_PUBKEY,
    check: (channel) => checkForAppUpdates(identity, false, channel),
  };
}

async function renderUpdate(client) {
  await client.service.init();
  await act(async () => { render(createElement(client.UpdaterContent)); });
}

async function download() {
  const button = screen.getByRole('button', { name: 'DOWNLOAD & INSTALL' });
  assert.ok(!button.classList.contains('btn-disabled'), 'update did not become downloadable');
  await act(async () => { fireEvent.click(button); });
}

test('old plugin configuration and default desktop selection (native source review)', () => {
  const oldConfig = JSON.parse(legacy(`${app}/src-tauri/tauri.conf.json`)).plugins.updater;
  const newConfig = appRequire('./src-tauri/tauri.conf.json').plugins.updater;
  const legacyClient = client('macos', 'aarch64');
  assert.deepEqual(oldConfig.endpoints, [legacyClient.READEST_UPDATER_FILE]);
  assert.equal(oldConfig.endpoints[0], endpoint);
  assert.equal(oldConfig.pubkey, legacyClient.READEST_UPDATER_PUBKEY);
  assert.equal(oldConfig.pubkey, newConfig.pubkey);

  const appRust = legacy(`${app}/src-tauri/src/lib.rs`);
  assert.match(appRust, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(appRust, /env_disable \|\| \(is_linux && \(is_flatpak \|\| !is_appimage\)\)/);
  assert.match(oldUpdater('src/commands.rs'), /if let Some\(target\) = target \{\s*builder = builder\.target\(target\);/);
  const updater = oldUpdater('src/updater.rs');
  assert.match(updater, /installer_for_bundle_type\(bundle_type\(\)\);\s*let \(download_url, signature\) = self\.get_urls/);
  assert.match(updater, /targets\.push\(format!\("\{os\}-\{arch\}-\{installer\}"\)\);\s*}\s*targets\.push\(format!\("\{os\}-\{arch\}"\)\);/);
  assert.match(updater, /\(release\.download_url\(target\), release\.signature\(target\)\)/);
  assert.match(updater, /cfg!\(target_os = "macos"\)[\s\S]*?Some\("darwin"\)/);
  for (const [bundle, suffix] of [['Nsis', 'nsis'], ['App', 'app'], ['AppImage', 'appimage']]) {
    assert.ok(updater.includes(`BundleType::${bundle} => Some(Installer::${bundle})`));
    assert.ok(updater.includes(`Self::${bundle} => "${suffix}"`));
  }
  assert.match(updater, /verify_signature\(&buffer, &self\.signature, &self\.config\.pubkey\)/);
});

test('Android plugin uses the architecture of the compiled Rust target', () => {
  assert.match(oldOs('src/lib.rs'), /fn arch\(\) -> &'static str \{\s*std::env::consts::ARCH\s*}/);
  assert.match(oldOs('src/lib.rs'), /arch:\s*crate::arch\(\)/);
  const build = legacy('.github/workflows/build-selfhost.yml');
  for (const [target, arch] of androidTargets) {
    assert.ok(build.includes(target), target);
    const cfg = execFileSync('rustc', ['--print', 'cfg', '--target', target], { encoding: 'utf8' });
    assert.ok(cfg.split('\n').includes(`target_arch="${arch}"`), target);
  }
});

for (const [label, arch, key, assetArch, forceFallback] of [
  ...androidTargets,
  ...androidAliases.map(([arch, key, asset]) => [`helper alias ${arch}`, arch, key, asset]),
  ['aarch64 without its specific entry', 'aarch64', 'android-universal', 'universal', true],
]) {
  test(`old Android updater: ${label} selects ${key}`, async () => {
    const data = structuredClone(manifest);
    if (forceFallback) delete data.platforms['android-arm64'];
    const old = client('android', arch, { data });
    assert.deepEqual(old.getAndroidUpdatePlatform(arch, data.platforms), { key, assetArch });
    assertEntry(key, apk(assetArch));
    await old.service.init();
    render(createElement(old.UpdaterWindow));
    await act(async () => assert.equal(await old.check(), true));
    await download();
    const file = `/Cache/Readest_${version}_${assetArch}.apk`;
    assert.deepEqual(old.calls.fetch, [endpoint, endpoint]);
    assert.deepEqual(old.calls.downloads, [[assetUrl(apk(assetArch)), file]]);
    assert.deepEqual(old.calls.installs, [file]);
    assert.deepEqual(old.calls.verifies, []); // Stable custom path does not use the .sig.
    assert.deepEqual(old.calls.native, []);
  });
}

test('old Android updater does not offer an update without a compatible entry', async () => {
  const data = structuredClone(manifest);
  delete data.platforms['android-universal'];
  const old = client('android', 'arm', { data });
  await old.service.init();
  render(createElement(old.UpdaterWindow));
  await act(async () => assert.equal(await old.check(), false));
  assert.equal(screen.queryByRole('button', { name: 'DOWNLOAD & INSTALL' }), null);
});

for (const [os, arch, format, asset] of desktopTargets) {
  test(`old ${os} ${arch} ${format}: native IPC plus bundle-specific and fallback entries`, async () => {
    const old = client(os, arch);
    assert.equal(await old.check(), true);
    assert.equal(old.calls.windows[0][1].url, `/updater?latestVersion=${version}`);
    await renderUpdate(old);
    await download();
    const prefix = `${os === 'macos' ? 'darwin' : 'windows'}-${arch}`;
    assertEntry(`${prefix}-${format}`, asset);
    assertEntry(prefix, asset);
    assert.deepEqual(old.calls.native, [
      ['plugin:updater|check', {}], ['is_updater_disabled'], ['plugin:updater|check', {}],
      ['plugin:updater|download_and_install', { rid: 1 }],
    ]);
    assert.deepEqual(old.calls.downloads, []);
  });
}

for (const [os, arch, key, asset, path, flags] of [
  ...[['x86_64', 'x64'], ['aarch64', 'arm64']].map(([arch, name]) => [
    'windows', arch, `windows-${arch}-portable`, windows(name, 'portable'),
    `/exec/Readest_${version}_${name}-portable.exe`, { portable: true },
  ]),
  ...appImages.map(([arch, asset]) => [
    'linux', arch, `linux-${arch}-appimage`, asset,
    `/desktop/Readest_${version}_${arch}.AppImage`, { isAppImage: true },
  ]),
]) {
  test(`old ${key}: stable updater downloads the custom package`, async () => {
    const old = client(os, arch, flags);
    assert.equal(await old.check(), true);
    await renderUpdate(old);
    await download();
    assertEntry(key, asset);
    if (flags.isAppImage) assertEntry(`linux-${arch}`, asset);
    assert.deepEqual(old.calls.fetch, [endpoint]);
    assert.deepEqual(old.calls.downloads, [[assetUrl(asset), path]]);
    assert.deepEqual(old.calls.native, [['plugin:updater|check', {}], ['is_updater_disabled']]);
    assert.deepEqual(old.calls.verifies, []);
  });
}

for (const [arch, format, asset] of linuxPackages) {
  test(`old Linux ${arch} ${format}: package exists; updater disabled by native command`, async () => {
    const old = client('linux', arch, { disabled: true });
    await renderUpdate(old);
    assertEntry(`linux-${arch}-${format}`, asset);
    assert.equal(old.service.hasUpdater, false);
    assert.deepEqual(old.calls.native, [['is_updater_disabled']]);
    assert.deepEqual(old.calls.fetch, []);
    assert.equal(screen.queryByRole('button', { name: 'DOWNLOAD & INSTALL' }), null);
  });
}

test('old selfhost nightly setting resolves the stable feed and forwards selected signature', async () => {
  const old = client('android', 'aarch64');
  await old.service.init();
  render(createElement(old.UpdaterWindow));
  await act(async () => assert.equal(await old.check('nightly'), true));
  await download();
  const asset = apk('arm64');
  const file = `/Cache/${asset}`;
  assert.deepEqual(old.calls.fetch, [endpoint, endpoint]);
  assert.deepEqual(old.calls.downloads, [[assetUrl(asset), file]]);
  assert.deepEqual(old.calls.verifies, [[file, signature(asset), old.READEST_UPDATER_PUBKEY]]);
  assert.deepEqual(old.calls.installs, [file]);
});
