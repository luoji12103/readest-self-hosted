import { beforeEach, describe, expect, test, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({
  billingEnabled: true,
  emailInEnabled: true,
  emailInRequiresPremium: true,
  cloudSyncRequiresPremium: true,
  ttsCacheRequiresPremium: true,
  bookFileUploadEnabled: true,
  translationProviders: ['deepl', 'azure', 'google', 'yandex'],
  translationDailyQuota: null,
  clientDownloadUrl: 'https://readest.com',
}));

vi.mock('@/services/runtimeConfig', () => ({
  getRuntimeCapabilities: () => capabilities,
  getRuntimeConfig: () => undefined,
}));

import { isCloudSyncAllowed, isEmailInAllowed, isTTSCacheAllowed } from '@/utils/access';

describe('runtime capability gates', () => {
  beforeEach(() => {
    Object.assign(capabilities, {
      billingEnabled: true,
      emailInEnabled: true,
      emailInRequiresPremium: true,
      cloudSyncRequiresPremium: true,
      ttsCacheRequiresPremium: true,
      bookFileUploadEnabled: true,
      translationProviders: ['deepl', 'azure', 'google', 'yandex'],
      translationDailyQuota: null,
      clientDownloadUrl: 'https://readest.com',
    });
  });

  test('preserves hosted premium gates', () => {
    expect(isEmailInAllowed('free')).toBe(false);
    expect(isCloudSyncAllowed('free')).toBe(false);
    expect(isTTSCacheAllowed('free')).toBe(false);
  });

  test('removes premium gates independently when the server allows it', () => {
    capabilities.emailInRequiresPremium = false;
    capabilities.cloudSyncRequiresPremium = false;
    capabilities.ttsCacheRequiresPremium = false;

    expect(isEmailInAllowed('free')).toBe(true);
    expect(isCloudSyncAllowed('free')).toBe(true);
    expect(isTTSCacheAllowed('free')).toBe(true);
  });

  test('keeps email ingestion unavailable when disabled', () => {
    capabilities.emailInEnabled = false;
    capabilities.emailInRequiresPremium = false;

    expect(isEmailInAllowed('pro')).toBe(false);
  });
});
