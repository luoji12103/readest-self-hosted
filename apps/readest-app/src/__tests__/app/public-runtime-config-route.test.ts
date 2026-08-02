import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/.well-known/readest-client-config.json/route';

describe('public Readest client config route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns portable public runtime config with cross-origin access', async () => {
    vi.stubEnv('API_BASE_URL', 'https://reader.example.com');
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'https://sync.example.com');
    vi.stubEnv('SUPABASE_ANON_KEY', 'public-anon-key');
    vi.stubEnv('SERVICE_ROLE_KEY', 'must-not-be-exposed');
    vi.stubEnv('READEST_DEPLOYMENT_MODE', 'self-hosted');
    vi.stubEnv('READEST_BILLING_ENABLED', 'false');
    vi.stubEnv('READEST_EMAIL_IN_ENABLED', 'false');
    vi.stubEnv('READEST_EMAIL_IN_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_CLOUD_SYNC_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_TTS_CACHE_REQUIRES_PREMIUM', 'false');
    vi.stubEnv('READEST_BOOK_FILE_UPLOAD_ENABLED', 'false');
    vi.stubEnv('READEST_DEEPL_ENABLED', 'false');

    const response = GET();
    const config = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(config).toMatchObject({
      apiBaseUrl: 'https://reader.example.com',
      supabaseUrl: 'https://sync.example.com',
      supabaseAnonKey: 'public-anon-key',
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
    expect(JSON.stringify(config)).not.toContain('must-not-be-exposed');
  });
});
