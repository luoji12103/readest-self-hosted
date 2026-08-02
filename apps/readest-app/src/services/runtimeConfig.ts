import { getCustomServerRuntimeConfig } from './customServerConfig';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  type PublicReadestClientConfig,
  type ReadestDeploymentMode,
  type ReadestRuntimeCapabilities,
  type ReadestTranslationProvider,
} from './runtimeConfigTypes';

export type ReadestRuntimeConfig = PublicReadestClientConfig;
export { DEFAULT_RUNTIME_CAPABILITIES };

declare global {
  interface Window {
    __READEST_RUNTIME_CONFIG?: ReadestRuntimeConfig;
  }
}

const shouldUseCustomServerConfig = () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';

const readBooleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
};

const readDeploymentMode = (): ReadestDeploymentMode => {
  const value = process.env['READEST_DEPLOYMENT_MODE'] ?? 'hosted';
  if (value !== 'hosted' && value !== 'self-hosted') {
    throw new Error('READEST_DEPLOYMENT_MODE must be hosted or self-hosted.');
  }
  return value;
};

const TRANSLATION_PROVIDERS: readonly ReadestTranslationProvider[] = [
  'deepl',
  'azure',
  'google',
  'yandex',
];

const readTranslationProviders = (): ReadestTranslationProvider[] => {
  const value = process.env['READEST_TRANSLATION_PROVIDERS'];
  if (value === undefined) return [...TRANSLATION_PROVIDERS];
  if (value.trim() === '') return [];

  const providers = [
    ...new Set(
      value
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
  ];
  const unsupported = providers.find(
    (provider) => !(TRANSLATION_PROVIDERS as readonly string[]).includes(provider),
  );
  if (unsupported) {
    throw new Error(`READEST_TRANSLATION_PROVIDERS contains unsupported provider: ${unsupported}.`);
  }
  return providers as ReadestTranslationProvider[];
};

const readNullableQuotaEnv = (name: string): number | null => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
};

const readClientDownloadUrl = (deploymentMode: ReadestDeploymentMode): string | null => {
  const value = process.env['READEST_CLIENT_DOWNLOAD_URL'];
  if (value === undefined || value.trim() === '') {
    return deploymentMode === 'hosted' ? DEFAULT_RUNTIME_CAPABILITIES.clientDownloadUrl : null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('READEST_CLIENT_DOWNLOAD_URL must be an https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('READEST_CLIENT_DOWNLOAD_URL must be an https URL.');
  }
  return url.toString();
};

const getServerCapabilities = (
  deploymentMode = readDeploymentMode(),
): ReadestRuntimeCapabilities => ({
  billingEnabled: readBooleanEnv('READEST_BILLING_ENABLED', true),
  emailInEnabled: readBooleanEnv('READEST_EMAIL_IN_ENABLED', true),
  emailInRequiresPremium: readBooleanEnv('READEST_EMAIL_IN_REQUIRES_PREMIUM', true),
  cloudSyncRequiresPremium: readBooleanEnv('READEST_CLOUD_SYNC_REQUIRES_PREMIUM', true),
  ttsCacheRequiresPremium: readBooleanEnv('READEST_TTS_CACHE_REQUIRES_PREMIUM', true),
  bookFileUploadEnabled: readBooleanEnv('READEST_BOOK_FILE_UPLOAD_ENABLED', true),
  translationProviders: readTranslationProviders(),
  translationDailyQuota: readNullableQuotaEnv('READEST_TRANSLATION_DAILY_QUOTA'),
  clientDownloadUrl: readClientDownloadUrl(deploymentMode),
});

export const getRuntimeConfig = (): ReadestRuntimeConfig | undefined => {
  if (typeof window === 'undefined') return undefined;
  if (shouldUseCustomServerConfig()) {
    const customConfig = getCustomServerRuntimeConfig();
    if (customConfig) return { ...window.__READEST_RUNTIME_CONFIG, ...customConfig };
  }
  return window.__READEST_RUNTIME_CONFIG;
};

export const getServerRuntimeConfig = (): ReadestRuntimeConfig => {
  const deploymentMode = readDeploymentMode();
  return {
    // Browser runtime config should prefer a public Supabase URL when provided.
    // SUPABASE_URL remains as a backward-compatible fallback for non-split setups.
    supabaseUrl:
      process.env['SUPABASE_PUBLIC_URL'] ??
      process.env['NEXT_PUBLIC_SUPABASE_URL'] ??
      process.env['SUPABASE_URL'],
    supabaseAnonKey:
      process.env['SUPABASE_ANON_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    apiBaseUrl:
      process.env['API_BASE_URL'] ??
      process.env['NEXT_PUBLIC_API_BASE_URL'] ??
      process.env['SITE_URL'],
    // These were previously baked as NEXT_PUBLIC_* build args; now read from runtime env so
    // the published image can be configured without rebuilding.
    objectStorageType:
      process.env['OBJECT_STORAGE_TYPE'] ?? process.env['NEXT_PUBLIC_OBJECT_STORAGE_TYPE'],
    storageFixedQuota: (() => {
      const raw =
        process.env['STORAGE_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_STORAGE_FIXED_QUOTA'];
      return raw ? parseInt(raw, 10) : undefined;
    })(),
    translationFixedQuota: (() => {
      const raw =
        process.env['TRANSLATION_FIXED_QUOTA'] ??
        process.env['NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA'];
      return raw ? parseInt(raw, 10) : undefined;
    })(),
    deploymentMode,
    capabilities: getServerCapabilities(deploymentMode),
  };
};

export const getRuntimeCapabilities = (): ReadestRuntimeCapabilities => {
  if (typeof window === 'undefined') return getServerCapabilities();
  return getRuntimeConfig()?.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
};

export const getDeploymentMode = (): ReadestDeploymentMode => {
  if (typeof window === 'undefined') return readDeploymentMode();
  return getRuntimeConfig()?.deploymentMode ?? 'hosted';
};

export const getClientDownloadUrl = (): string | null => getRuntimeCapabilities().clientDownloadUrl;

export const isBookFileUploadEnabled = (): boolean =>
  getRuntimeCapabilities().bookFileUploadEnabled;
