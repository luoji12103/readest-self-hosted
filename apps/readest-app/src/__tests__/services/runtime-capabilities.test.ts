import { afterEach, describe, expect, test, vi } from 'vitest';
import { getServerRuntimeConfig } from '@/services/runtimeConfig';

describe('server runtime capabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('preserves hosted behavior by default', () => {
    expect(getServerRuntimeConfig()).toMatchObject({
      deploymentMode: 'hosted',
      capabilities: {
        billingEnabled: true,
        emailInEnabled: true,
        emailInRequiresPremium: true,
        cloudSyncRequiresPremium: true,
        ttsCacheRequiresPremium: true,
        bookFileUploadEnabled: true,
        translationProviders: ['deepl', 'azure', 'google', 'yandex'],
        translationDailyQuota: null,
        clientDownloadUrl: 'https://readest.com?utm_source=readest_web',
      },
    });
  });

  test('reads a self-hosted policy from strict boolean environment values', () => {
    vi.stubEnv('READEST_DEPLOYMENT_MODE', 'self-hosted');
    vi.stubEnv('READEST_BILLING_ENABLED', 'false');
    vi.stubEnv('READEST_EMAIL_IN_ENABLED', 'false');
    vi.stubEnv('READEST_EMAIL_IN_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_CLOUD_SYNC_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_TTS_CACHE_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_BOOK_FILE_UPLOAD_ENABLED', 'false');
    vi.stubEnv('READEST_TRANSLATION_PROVIDERS', 'google,azure,yandex');
    vi.stubEnv('READEST_TRANSLATION_DAILY_QUOTA', '25000');
    vi.stubEnv('READEST_CLIENT_DOWNLOAD_URL', 'https://downloads.example.com/readest');

    expect(getServerRuntimeConfig()).toMatchObject({
      deploymentMode: 'self-hosted',
      capabilities: {
        billingEnabled: false,
        emailInEnabled: false,
        emailInRequiresPremium: false,
        cloudSyncRequiresPremium: false,
        ttsCacheRequiresPremium: false,
        bookFileUploadEnabled: false,
        translationProviders: ['google', 'azure', 'yandex'],
        translationDailyQuota: 25000,
        clientDownloadUrl: 'https://downloads.example.com/readest',
      },
    });
  });

  test('rejects ambiguous boolean values', () => {
    vi.stubEnv('READEST_BILLING_ENABLED', '0');

    expect(() => getServerRuntimeConfig()).toThrow(
      'READEST_BILLING_ENABLED must be true or false.',
    );
  });

  test('allows a deployment to disable every translation provider', () => {
    vi.stubEnv('READEST_TRANSLATION_PROVIDERS', '');

    expect(getServerRuntimeConfig().capabilities?.translationProviders).toEqual([]);
  });

  test('rejects an unsupported translation provider', () => {
    vi.stubEnv('READEST_TRANSLATION_PROVIDERS', 'google,unknown');

    expect(() => getServerRuntimeConfig()).toThrow(
      'READEST_TRANSLATION_PROVIDERS contains unsupported provider: unknown.',
    );
  });

  test('does not advertise a download when a self-hosted deployment omits one', () => {
    vi.stubEnv('READEST_DEPLOYMENT_MODE', 'self-hosted');

    expect(getServerRuntimeConfig().capabilities?.clientDownloadUrl).toBeNull();
  });

  test('rejects a malformed client download URL', () => {
    vi.stubEnv('READEST_CLIENT_DOWNLOAD_URL', 'not-a-url');

    expect(() => getServerRuntimeConfig()).toThrow(
      'READEST_CLIENT_DOWNLOAD_URL must be an https URL.',
    );
  });
});
