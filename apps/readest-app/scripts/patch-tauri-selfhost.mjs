import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const configPath = resolve(appDir, process.env.TAURI_CONF_PATH ?? 'src-tauri/tauri.conf.json');

const defaultProductName = 'Readest SH';
const defaultIdentifier = 'com.readest.selfhost';
const defaultUpdaterEndpoint =
  'https://github.com/luoji12103/readest-self-hosted/releases/latest/download/latest.json';
const defaultUpdaterPubkey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERDMTFCNEI4QTZDQUI5MkEKUldRcXVjcW11TFFSM0JBMkhWcGV0aW8yUlNneERzNnJtaUZjY3ViYmtyYWZwaEx4UzBEdi9WM3kK';

const readEnv = (name, fallback) => {
  const value = process.env[name]?.trim();
  return value || fallback;
};

const assertHttpsUrl = (value, name) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS`);
  }
  if (parsed.hostname === 'download.readest.com') {
    throw new Error(`${name} must not point to the official Readest updater`);
  }
  if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/readest/readest/')) {
    throw new Error(`${name} must not point to the official Readest GitHub release`);
  }
  return parsed.toString();
};

const assertIdentifier = (value) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/.test(value)) {
    throw new Error('SELFHOST_APP_IDENTIFIER must be a reverse-DNS identifier');
  }
  return value;
};

const assertPubkey = (value) => {
  if (!value || value.length < 32) {
    throw new Error('TAURI_UPDATER_PUBKEY must be set to a valid public key');
  }
  if (/PRIVATE KEY|BEGIN|secret key/i.test(value)) {
    throw new Error('TAURI_UPDATER_PUBKEY must be public updater key material only');
  }
  return value;
};

const config = JSON.parse(await readFile(configPath, 'utf8'));

config.productName = readEnv('SELFHOST_PRODUCT_NAME', defaultProductName);
config.identifier = assertIdentifier(readEnv('SELFHOST_APP_IDENTIFIER', defaultIdentifier));
config.bundle ??= {};
config.bundle.createUpdaterArtifacts = true;
config.plugins ??= {};
config.plugins.updater ??= {};
config.plugins.updater.pubkey = assertPubkey(readEnv('TAURI_UPDATER_PUBKEY', defaultUpdaterPubkey));
config.plugins.updater.endpoints = [
  assertHttpsUrl(readEnv('TAURI_UPDATER_ENDPOINT', defaultUpdaterEndpoint), 'TAURI_UPDATER_ENDPOINT'),
];

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(
  [
    `Patched ${configPath}`,
    `productName=${config.productName}`,
    `identifier=${config.identifier}`,
    `updaterEndpoint=${config.plugins.updater.endpoints[0]}`,
  ].join('\n'),
);
