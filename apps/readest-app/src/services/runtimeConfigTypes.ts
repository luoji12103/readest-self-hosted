export type ReadestDeploymentMode = 'hosted' | 'self-hosted';

export type ReadestTranslationProvider = 'deepl' | 'azure' | 'google' | 'yandex';

export interface ReadestRuntimeCapabilities {
  billingEnabled: boolean;
  emailInEnabled: boolean;
  emailInRequiresPremium: boolean;
  cloudSyncRequiresPremium: boolean;
  ttsCacheRequiresPremium: boolean;
  bookFileUploadEnabled: boolean;
  translationProviders: ReadestTranslationProvider[];
  translationDailyQuota: number | null;
  clientDownloadUrl: string | null;
}

export const DEFAULT_RUNTIME_CAPABILITIES: ReadestRuntimeCapabilities = {
  billingEnabled: true,
  emailInEnabled: true,
  emailInRequiresPremium: true,
  cloudSyncRequiresPremium: true,
  ttsCacheRequiresPremium: true,
  bookFileUploadEnabled: true,
  translationProviders: ['deepl', 'azure', 'google', 'yandex'],
  translationDailyQuota: null,
  clientDownloadUrl: 'https://readest.com?utm_source=readest_web',
};

export interface PublicReadestClientConfig {
  apiBaseUrl?: string | undefined;
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
  objectStorageType?: string | undefined;
  storageFixedQuota?: number | undefined;
  translationFixedQuota?: number | undefined;
  deploymentMode?: ReadestDeploymentMode | undefined;
  capabilities?: ReadestRuntimeCapabilities | undefined;
}
