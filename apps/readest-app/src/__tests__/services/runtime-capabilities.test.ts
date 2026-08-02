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
        deeplEnabled: true,
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
    vi.stubEnv('READEST_DEEPL_ENABLED', 'false');

    expect(getServerRuntimeConfig()).toMatchObject({
      deploymentMode: 'self-hosted',
      capabilities: {
        billingEnabled: false,
        emailInEnabled: false,
        emailInRequiresPremium: false,
        cloudSyncRequiresPremium: false,
        ttsCacheRequiresPremium: false,
        bookFileUploadEnabled: false,
        deeplEnabled: false,
      },
    });
  });

  test('rejects ambiguous boolean values', () => {
    vi.stubEnv('READEST_BILLING_ENABLED', '0');

    expect(() => getServerRuntimeConfig()).toThrow(
      'READEST_BILLING_ENABLED must be true or false.',
    );
  });
});
