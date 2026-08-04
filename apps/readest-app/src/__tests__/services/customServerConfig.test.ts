import { beforeEach, describe, expect, test, vi } from 'vitest';

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: tauriFetchMock,
}));

import {
  clearCustomServerConfig,
  CustomServerConfigError,
  fetchPublicClientConfig,
  getCustomServerConfigStorageKey,
  loadCustomServerConfig,
  normalizeServerBaseUrl,
  refreshCustomServerConfig,
  resolveCustomServerConfig,
  saveCustomServerConfig,
  setCustomServerConfigStorageAdapter,
} from '@/services/customServerConfig';
import * as customServerConfigModule from '@/services/customServerConfig';

const clearAuthSessionForServerChangeMock = vi.fn();

vi.mock('@/helpers/auth', () => ({
  clearAuthSessionForServerChange: () => clearAuthSessionForServerChangeMock(),
}));

const makeMemoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const encodeBase64Url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const jwtForRole = (role: string) =>
  `${encodeBase64Url({ alg: 'HS256', typ: 'JWT' })}.${encodeBase64Url({ role })}.signature`;

const anonJwt = jwtForRole('anon');

interface ManualConfigInput {
  serverBaseUrl: string;
  apiBaseUrl?: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

interface ManualConfigOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

type CreateManualConfig = (
  input: ManualConfigInput,
  options?: ManualConfigOptions,
) => Promise<{
  serverBaseUrl: string;
  apiBaseUrl: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  fetchedAt: number;
}>;

const getCreateManualConfig = () =>
  (
    customServerConfigModule as unknown as {
      createManualCustomServerConfig?: CreateManualConfig;
    }
  ).createManualCustomServerConfig;

const expectConfigError = (fn: () => unknown, code: string) => {
  try {
    fn();
    throw new Error('Expected CustomServerConfigError');
  } catch (error) {
    expect(error).toBeInstanceOf(CustomServerConfigError);
    expect((error as CustomServerConfigError).code).toBe(code);
  }
};

describe('customServerConfig', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    clearAuthSessionForServerChangeMock.mockReset();
    tauriFetchMock.mockReset();
    setCustomServerConfigStorageAdapter(null);
  });

  describe('normalizeServerBaseUrl', () => {
    test('trims and removes trailing slash', () => {
      expect(normalizeServerBaseUrl('  https://readest.example.com///  ')).toBe(
        'https://readest.example.com',
      );
    });

    test('rejects non-http schemes', () => {
      expectConfigError(() => normalizeServerBaseUrl('javascript:alert(1)'), 'invalid-url');
      expectConfigError(() => normalizeServerBaseUrl('file:///tmp/readest'), 'invalid-url');
      expectConfigError(() => normalizeServerBaseUrl('data:text/plain,readest'), 'invalid-url');
    });

    test('rejects invalid and credentialed URLs', () => {
      expectConfigError(() => normalizeServerBaseUrl('not a url'), 'invalid-url');
      expectConfigError(() => normalizeServerBaseUrl('https://user@example.com'), 'invalid-url');
    });

    test('rejects public http by default', () => {
      expectConfigError(
        () => normalizeServerBaseUrl('http://readest.example.com'),
        'insecure-http',
      );
    });

    test('allows local and private http when explicitly enabled', () => {
      expect(normalizeServerBaseUrl('http://localhost:3000/', { allowInsecureHttp: true })).toBe(
        'http://localhost:3000',
      );
      expect(normalizeServerBaseUrl('http://127.0.0.1:3000/', { allowInsecureHttp: true })).toBe(
        'http://127.0.0.1:3000',
      );
      expect(normalizeServerBaseUrl('http://192.168.1.20:3000/', { allowInsecureHttp: true })).toBe(
        'http://192.168.1.20:3000',
      );
    });
  });

  describe('fetchPublicClientConfig', () => {
    test('validates and normalizes public deployment policy', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
          objectStorageType: 's3',
          storageFixedQuota: 1024,
          translationFixedQuota: 2048,
          deploymentMode: 'self-hosted',
          capabilities: {
            billingEnabled: false,
            emailInEnabled: false,
            emailInRequiresPremium: false,
            cloudSyncRequiresPremium: false,
            ttsCacheRequiresPremium: false,
            bookFileUploadEnabled: false,
            translationProviders: ['google', 'azure', 'yandex'],
            translationDailyQuota: null,
            clientDownloadUrl: null,
          },
        }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).resolves.toMatchObject({
        objectStorageType: 's3',
        storageFixedQuota: 1024,
        translationFixedQuota: 2048,
        deploymentMode: 'self-hosted',
        capabilities: {
          billingEnabled: false,
          emailInEnabled: false,
          emailInRequiresPremium: false,
          cloudSyncRequiresPremium: false,
          ttsCacheRequiresPremium: false,
          bookFileUploadEnabled: false,
          translationProviders: ['google', 'azure', 'yandex'],
          translationDailyQuota: null,
          clientDownloadUrl: null,
        },
      });
    });

    test('fills missing capability fields with hosted-compatible defaults', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
          capabilities: { billingEnabled: false },
        }),
      ) as unknown as typeof fetch;

      const config = await fetchPublicClientConfig('https://readest.example.com', { fetchImpl });

      expect(config.capabilities).toEqual({
        billingEnabled: false,
        emailInEnabled: true,
        emailInRequiresPremium: true,
        cloudSyncRequiresPremium: true,
        ttsCacheRequiresPremium: true,
        bookFileUploadEnabled: true,
        translationProviders: ['deepl', 'azure', 'google', 'yandex'],
        translationDailyQuota: null,
        clientDownloadUrl: null,
      });
    });

    test('uses well-known config first', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com/',
          supabaseUrl: 'https://supabase.example.com/',
          supabaseAnonKey: anonJwt,
        }),
      ) as unknown as typeof fetch;

      const config = await fetchPublicClientConfig('https://readest.example.com', { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://readest.example.com/.well-known/readest-client-config.json',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(config).toEqual({
        apiBaseUrl: 'https://api.example.com',
        supabaseUrl: 'https://supabase.example.com',
        supabaseAnonKey: anonJwt,
      });
    });

    test('falls back to runtime-config endpoint', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'missing' }, 404))
        .mockResolvedValueOnce(
          jsonResponse({
            apiBaseUrl: 'https://api.example.com',
            supabaseUrl: 'https://supabase.example.com',
            supabaseAnonKey: anonJwt,
          }),
        ) as unknown as typeof fetch;

      const config = await fetchPublicClientConfig('https://readest.example.com', { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenLastCalledWith(
        'https://readest.example.com/api/public/runtime-config',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(config.apiBaseUrl).toBe('https://api.example.com');
    });

    test('defaults apiBaseUrl to serverBaseUrl when missing', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
        }),
      ) as unknown as typeof fetch;

      const config = await fetchPublicClientConfig('https://readest.example.com/', { fetchImpl });

      expect(config.apiBaseUrl).toBe('https://readest.example.com');
    });

    test('requires Supabase public config by default', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
        }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).rejects.toMatchObject({
        code: 'manual-config-required',
        suggestedConfig: { apiBaseUrl: 'https://api.example.com' },
      });
    });

    test('can validate configs without Supabase when explicitly allowed', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
        }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl,
          requireSupabase: false,
        }),
      ).resolves.toEqual({
        apiBaseUrl: 'https://api.example.com',
        supabaseUrl: undefined,
        supabaseAnonKey: undefined,
      });
    });

    test('rejects dangerous secret fields', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
          service_role: 'server-secret',
        }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).rejects.toMatchObject({ code: 'dangerous-secret' });
    });

    test('uses Tauri native HTTP when no fetch implementation is injected', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
      tauriFetchMock.mockResolvedValue(
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
        }),
      );

      await fetchPublicClientConfig('https://readest.example.com');

      expect(tauriFetchMock).toHaveBeenCalledTimes(1);
      expect(tauriFetchMock).toHaveBeenCalledWith(
        'https://readest.example.com/.well-known/readest-client-config.json',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    test('discovers runtime-config.js after both JSON endpoints fail', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(
          new Response(
            `window.__READEST_RUNTIME_CONFIG={"apiBaseUrl":"https://api.example.com","supabaseUrl":"https://supabase.example.com","supabaseAnonKey":"${anonJwt}"};`,
          ),
        ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).resolves.toMatchObject({ apiBaseUrl: 'https://api.example.com' });
      expect(fetchImpl).toHaveBeenNthCalledWith(
        3,
        'https://readest.example.com/runtime-config.js',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    test('rejects runtime scripts containing any second statement', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(
          new Response('window.__READEST_RUNTIME_CONFIG={};globalThis.compromised=true;'),
        ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).rejects.toMatchObject({ code: 'manual-config-required' });
      expect(
        (globalThis as typeof globalThis & { compromised?: boolean }).compromised,
      ).toBeUndefined();
    });

    test('accepts publishable keys and rejects service-role or secret keys', async () => {
      const makeFetch = (supabaseAnonKey: string) =>
        vi.fn(async () =>
          jsonResponse({
            supabaseUrl: 'https://supabase.example.com',
            supabaseAnonKey,
          }),
        ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl: makeFetch('sb_publishable_example_public_key_123456'),
        }),
      ).resolves.toMatchObject({ supabaseAnonKey: 'sb_publishable_example_public_key_123456' });
      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl: makeFetch(jwtForRole('service_role')),
        }),
      ).rejects.toMatchObject({ code: 'dangerous-secret' });
      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl: makeFetch('sb_secret_example_server_key'),
        }),
      ).rejects.toMatchObject({ code: 'dangerous-secret' });
    });

    test('returns a manual fallback with safe partial values when discovery is incomplete', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            apiBaseUrl: 'https://api.example.com',
            supabaseUrl: 'https://supabase.example.com',
          }),
        )
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('', { status: 404 })) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', { fetchImpl }),
      ).rejects.toMatchObject({
        code: 'manual-config-required',
        suggestedConfig: {
          apiBaseUrl: 'https://api.example.com',
          supabaseUrl: 'https://supabase.example.com',
        },
      });
    });

    test('rejects oversized discovery responses before parsing them', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
          padding: 'x'.repeat(256),
        }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl,
          maxResponseBytes: 64,
        }),
      ).rejects.toMatchObject({ code: 'manual-config-required' });
    });

    test('bounds every discovery request with an abort signal', async () => {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const fallback = setTimeout(
              () => reject(new Error('test fetch did not receive an abort signal')),
              50,
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(fallback);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl,
          timeoutMs: 1,
        }),
      ).rejects.toMatchObject({ code: 'manual-config-required' });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('keeps the discovery timeout active while reading the response body', async () => {
      let abortedBodies = 0;
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () =>
            new Promise<string>((_resolve, reject) => {
              const fallback = setTimeout(
                () => reject(new Error('response body was not aborted')),
                20,
              );
              init?.signal?.addEventListener(
                'abort',
                () => {
                  abortedBodies += 1;
                  clearTimeout(fallback);
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            }),
        } as Response),
      ) as unknown as typeof fetch;

      await expect(
        fetchPublicClientConfig('https://readest.example.com', {
          fetchImpl,
          timeoutMs: 1,
        }),
      ).rejects.toMatchObject({ code: 'manual-config-required' });
      expect(abortedBodies).toBe(3);
    });
  });

  describe('manual compatibility config', () => {
    const input = (): ManualConfigInput => ({
      serverBaseUrl: 'https://readest.example.com/',
      apiBaseUrl: '',
      supabaseUrl: 'https://supabase.example.com/',
      supabaseAnonKey: anonJwt,
    });

    test.each([200, 401, 403])('accepts Readest API HTTP %i as reachable', async (status) => {
      const createManualConfig = getCreateManualConfig();
      expect(createManualConfig).toBeTypeOf('function');
      if (!createManualConfig) return;
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status }))
        .mockResolvedValueOnce(jsonResponse({ external: {} })) as unknown as typeof fetch;

      const config = await createManualConfig(input(), { fetchImpl, now: () => 321 });

      expect(config).toEqual({
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://readest.example.com',
        supabaseUrl: 'https://supabase.example.com',
        supabaseAnonKey: anonJwt,
        fetchedAt: 321,
      });
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        'https://readest.example.com/api/sync',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        'https://supabase.example.com/auth/v1/settings',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            apikey: anonJwt,
            Authorization: `Bearer ${anonJwt}`,
          }),
        }),
      );
    });

    test('reports Readest API and Supabase failures separately', async () => {
      const createManualConfig = getCreateManualConfig();
      expect(createManualConfig).toBeTypeOf('function');
      if (!createManualConfig) return;

      await expect(
        createManualConfig(input(), {
          fetchImpl: vi.fn(
            async () => new Response('', { status: 404 }),
          ) as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'api-unreachable' });

      const supabaseFailure = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 403 }))
        .mockResolvedValueOnce(new Response('', { status: 503 })) as unknown as typeof fetch;
      await expect(
        createManualConfig(input(), { fetchImpl: supabaseFailure }),
      ).rejects.toMatchObject({ code: 'supabase-unreachable' });
    });

    test('distinguishes timeout and TLS failures', async () => {
      const createManualConfig = getCreateManualConfig();
      expect(createManualConfig).toBeTypeOf('function');
      if (!createManualConfig) return;

      const timeoutFetch = vi.fn(
        (_request: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ) as unknown as typeof fetch;
      await expect(
        createManualConfig(input(), { fetchImpl: timeoutFetch, timeoutMs: 1 }),
      ).rejects.toMatchObject({ code: 'request-timeout' });

      const tlsFetch = vi.fn(async () => {
        throw new TypeError('certificate verify failed during TLS handshake');
      }) as unknown as typeof fetch;
      await expect(createManualConfig(input(), { fetchImpl: tlsFetch })).rejects.toMatchObject({
        code: 'tls-error',
      });
    });

    test('rejects malformed public keys without making a request', async () => {
      const createManualConfig = getCreateManualConfig();
      expect(createManualConfig).toBeTypeOf('function');
      if (!createManualConfig) return;
      const fetchImpl = vi.fn();

      await expect(
        createManualConfig(
          { ...input(), supabaseAnonKey: 'not-a-supabase-public-key' },
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ code: 'invalid-config' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('does not mutate input after failed validation', async () => {
      const createManualConfig = getCreateManualConfig();
      expect(createManualConfig).toBeTypeOf('function');
      if (!createManualConfig) return;
      const values = input();
      const original = { ...values };

      await expect(
        createManualConfig(values, {
          fetchImpl: vi.fn(
            async () => new Response('', { status: 500 }),
          ) as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'api-unreachable' });
      expect(values).toEqual(original);
    });
  });

  describe('storage', () => {
    test('refreshes and caches capabilities without losing the offline copy', async () => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);
      await saveCustomServerConfig({
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://readest.example.com',
        supabaseUrl: 'https://sync.example.com',
        supabaseAnonKey: anonJwt,
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
        fetchedAt: 1,
      });

      await refreshCustomServerConfig({
        now: () => 2,
        fetchImpl: vi.fn(async () =>
          jsonResponse({
            apiBaseUrl: 'https://readest.example.com',
            supabaseUrl: 'https://sync.example.com',
            supabaseAnonKey: anonJwt,
            deploymentMode: 'self-hosted',
            capabilities: {
              billingEnabled: false,
              emailInEnabled: false,
              emailInRequiresPremium: false,
              cloudSyncRequiresPremium: false,
              ttsCacheRequiresPremium: false,
              bookFileUploadEnabled: false,
              translationProviders: ['google', 'azure', 'yandex'],
              translationDailyQuota: null,
              clientDownloadUrl: null,
            },
          }),
        ) as unknown as typeof fetch,
      });

      expect(loadCustomServerConfig()).toMatchObject({
        deploymentMode: 'self-hosted',
        capabilities: {
          billingEnabled: false,
          emailInEnabled: false,
          emailInRequiresPremium: false,
          cloudSyncRequiresPremium: false,
          ttsCacheRequiresPremium: false,
          bookFileUploadEnabled: false,
          translationProviders: ['google', 'azure', 'yandex'],
          translationDailyQuota: null,
          clientDownloadUrl: null,
        },
        fetchedAt: 2,
      });

      const offlineCopy = loadCustomServerConfig();
      await expect(
        refreshCustomServerConfig({
          fetchImpl: vi.fn(async () => {
            throw new TypeError('offline');
          }) as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'manual-config-required' });
      expect(loadCustomServerConfig()).toEqual(offlineCopy);
    });

    test('saves, reads, and clears current custom server config', async () => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          apiBaseUrl: 'https://api.example.com',
          supabaseUrl: 'https://supabase.example.com',
          supabaseAnonKey: anonJwt,
        }),
      ) as unknown as typeof fetch;

      const config = await resolveCustomServerConfig('https://readest.example.com', {
        fetchImpl,
        now: () => 123,
      });

      await saveCustomServerConfig(config);

      expect(storage.values.has(getCustomServerConfigStorageKey())).toBe(true);
      expect(loadCustomServerConfig()).toEqual({
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://api.example.com',
        supabaseUrl: 'https://supabase.example.com',
        supabaseAnonKey: anonJwt,
        fetchedAt: 123,
      });

      await clearCustomServerConfig();
      expect(loadCustomServerConfig()).toBeNull();
    });

    test('resets session when saving a different server with resetSession', async () => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);

      await saveCustomServerConfig({
        serverBaseUrl: 'https://old.example.com',
        apiBaseUrl: 'https://old.example.com',
        supabaseUrl: 'https://old-supabase.example.com',
        supabaseAnonKey: 'old-anon-key',
        fetchedAt: 1,
      });

      await saveCustomServerConfig(
        {
          serverBaseUrl: 'https://new.example.com',
          apiBaseUrl: 'https://new.example.com',
          supabaseUrl: 'https://new-supabase.example.com',
          supabaseAnonKey: 'new-anon-key',
          fetchedAt: 2,
        },
        { resetSession: true },
      );

      expect(clearAuthSessionForServerChangeMock).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['API URL', { apiBaseUrl: 'https://new-api.example.com' }],
      ['Supabase URL', { supabaseUrl: 'https://new-supabase.example.com' }],
      ['Supabase key', { supabaseAnonKey: 'new-public-key' }],
    ])('resets session when the effective %s changes', async (_label, changedFields) => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);
      const original = {
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://api.example.com',
        supabaseUrl: 'https://supabase.example.com',
        supabaseAnonKey: 'public-key',
        fetchedAt: 1,
      };
      await saveCustomServerConfig(original);
      clearAuthSessionForServerChangeMock.mockClear();

      await saveCustomServerConfig(
        { ...original, ...changedFields, fetchedAt: 2 },
        { resetSession: true },
      );

      expect(clearAuthSessionForServerChangeMock).toHaveBeenCalledTimes(1);
    });

    test('does not reset session when the effective config is unchanged', async () => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);
      const config = {
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://api.example.com',
        supabaseUrl: 'https://supabase.example.com',
        supabaseAnonKey: 'public-key',
        fetchedAt: 1,
      };
      await saveCustomServerConfig(config);
      clearAuthSessionForServerChangeMock.mockClear();

      await saveCustomServerConfig({ ...config, fetchedAt: 2 }, { resetSession: true });

      expect(clearAuthSessionForServerChangeMock).not.toHaveBeenCalled();
    });

    test('resets session when clearing an active custom server config', async () => {
      const storage = makeMemoryStorage();
      setCustomServerConfigStorageAdapter(storage);

      await saveCustomServerConfig({
        serverBaseUrl: 'https://readest.example.com',
        apiBaseUrl: 'https://readest.example.com',
        fetchedAt: 1,
      });
      clearAuthSessionForServerChangeMock.mockClear();

      await clearCustomServerConfig({ resetSession: true });

      expect(clearAuthSessionForServerChangeMock).toHaveBeenCalledTimes(1);
    });
  });
});
