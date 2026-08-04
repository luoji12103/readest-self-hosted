import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { jwtDecode } from 'jwt-decode';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  type PublicReadestClientConfig,
  type ReadestDeploymentMode,
  type ReadestRuntimeCapabilities,
  type ReadestTranslationProvider,
} from './runtimeConfigTypes';

export interface CustomServerConfig extends PublicReadestClientConfig {
  serverBaseUrl: string;
  apiBaseUrl: string;
  fetchedAt: number;
}

export interface ManualCustomServerConfigInput {
  serverBaseUrl: string;
  apiBaseUrl?: string | undefined;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

interface StorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export type CustomServerConfigErrorCode =
  | 'invalid-url'
  | 'insecure-http'
  | 'server-not-reachable'
  | 'invalid-config'
  | 'missing-supabase-config'
  | 'dangerous-secret'
  | 'manual-config-required'
  | 'request-timeout'
  | 'tls-error'
  | 'api-unreachable'
  | 'supabase-unreachable';

export class CustomServerConfigError extends Error {
  code: CustomServerConfigErrorCode;
  suggestedConfig?: PublicReadestClientConfig | undefined;

  constructor(
    code: CustomServerConfigErrorCode,
    message: string,
    suggestedConfig?: PublicReadestClientConfig,
  ) {
    super(message);
    this.name = 'CustomServerConfigError';
    this.code = code;
    this.suggestedConfig = suggestedConfig;
  }
}

interface NormalizeUrlOptions {
  allowInsecureHttp?: boolean;
}

interface ResolveCustomServerConfigOptions extends NormalizeUrlOptions {
  fetchImpl?: typeof fetch;
  requireSupabase?: boolean;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface SaveCustomServerConfigOptions {
  resetSession?: boolean;
}

const CUSTOM_SERVER_CONFIG_KEY = 'readest_custom_server_config_v1';

const PUBLIC_CONFIG_SOURCES = [
  { path: '/.well-known/readest-client-config.json', format: 'json' },
  { path: '/api/public/runtime-config', format: 'json' },
  { path: '/runtime-config.js', format: 'script' },
] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const DANGEROUS_SECRET_FIELDS = [
  'service_role',
  'jwt_secret',
  'postgres_password',
  'database_url',
  's3_secret',
  'aws_secret_access_key',
  'private_key',
] as const;

let storageAdapter: StorageAdapter | null = null;

const getStorageAdapter = (): StorageAdapter | null => {
  if (storageAdapter) return storageAdapter;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
};

export const setCustomServerConfigStorageAdapter = (adapter: StorageAdapter | null) => {
  storageAdapter = adapter;
};

const isDevelopmentBuild = () => process.env['NODE_ENV'] === 'development';
const isTauriClientBuild = () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '');

const isPrivateIpv4 = (hostname: string) => {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const first = octets[0]!;
  const second = octets[1]!;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

const isLocalOrPrivateHost = (hostname: string) => {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.endsWith('.local') ||
    isPrivateIpv4(normalized)
  );
};

export const normalizeServerBaseUrl = (
  input: string,
  { allowInsecureHttp = isDevelopmentBuild() }: NormalizeUrlOptions = {},
) => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CustomServerConfigError('invalid-url', 'Server URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CustomServerConfigError('invalid-url', 'Server URL must be a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CustomServerConfigError('invalid-url', 'Server URL must use http or https.');
  }

  if (parsed.username || parsed.password) {
    throw new CustomServerConfigError('invalid-url', 'Server URL must not include credentials.');
  }

  if (
    parsed.protocol === 'http:' &&
    !(allowInsecureHttp && isLocalOrPrivateHost(parsed.hostname))
  ) {
    throw new CustomServerConfigError(
      'insecure-http',
      'Insecure http is only allowed for local development servers.',
    );
  }

  parsed.hash = '';
  parsed.search = '';

  return parsed.toString().replace(/\/+$/, '');
};

const normalizeConfigUrl = (input: string, options: NormalizeUrlOptions) =>
  normalizeServerBaseUrl(input, options);

const joinUrlPath = (baseUrl: string, path: string) => {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path}`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeSecretField = (field: string) => field.toLowerCase().replace(/[-\s]/g, '_');

const findDangerousSecretField = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDangerousSecretField(item);
      if (found) return found;
    }
    return null;
  }

  if (!isPlainObject(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeSecretField(key);
    const dangerousField = DANGEROUS_SECRET_FIELDS.find((field) => normalizedKey.includes(field));
    if (dangerousField) return key;

    const found = findDangerousSecretField(child);
    if (found) return found;
  }

  return null;
};

const assertNoDangerousSecrets = (config: unknown) => {
  const field = findDangerousSecretField(config);
  if (field) {
    throw new CustomServerConfigError(
      'dangerous-secret',
      `Server config exposes a dangerous secret field: ${field}.`,
    );
  }
};

const validateSupabasePublicKey = (key: string) => {
  if (key.startsWith('sb_secret_')) {
    throw new CustomServerConfigError(
      'dangerous-secret',
      'Supabase server secret keys must not be used in the client.',
    );
  }

  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return;

  try {
    const payload = jwtDecode<{ role?: unknown }>(key);
    if (payload.role === 'service_role') {
      throw new CustomServerConfigError(
        'dangerous-secret',
        'Supabase service-role keys must not be used in the client.',
      );
    }
    if (payload.role === 'anon') return;
  } catch (error) {
    if (error instanceof CustomServerConfigError) throw error;
  }

  throw new CustomServerConfigError(
    'invalid-config',
    'Supabase public key must be an anon JWT or publishable key.',
  );
};

const optionalNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CustomServerConfigError('invalid-config', `${field} must be a non-negative number.`);
  }
  return value;
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new CustomServerConfigError('invalid-config', `${field} must be a boolean.`);
  }
  return value;
};

const TRANSLATION_PROVIDERS: readonly ReadestTranslationProvider[] = [
  'deepl',
  'azure',
  'google',
  'yandex',
];

const optionalTranslationProviders = (value: unknown): ReadestTranslationProvider[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (provider) =>
        typeof provider !== 'string' ||
        !(TRANSLATION_PROVIDERS as readonly string[]).includes(provider),
    )
  ) {
    throw new CustomServerConfigError(
      'invalid-config',
      'capabilities.translationProviders contains an unsupported provider.',
    );
  }
  return [...new Set(value)] as ReadestTranslationProvider[];
};

const optionalNullableNumber = (value: unknown, field: string): number | null | undefined => {
  if (value === undefined || value === null) return value;
  return optionalNumber(value, field);
};

const optionalNullableHttpsUrl = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw new CustomServerConfigError('invalid-config', `${field} must be an https URL or null.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CustomServerConfigError('invalid-config', `${field} must be an https URL or null.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CustomServerConfigError('invalid-config', `${field} must be an https URL or null.`);
  }
  return url.toString();
};

const validateCapabilities = (value: unknown): ReadestRuntimeCapabilities | undefined => {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new CustomServerConfigError('invalid-config', 'capabilities must be an object.');
  }

  const translationProviders = optionalTranslationProviders(value['translationProviders']);
  const translationDailyQuota = optionalNullableNumber(
    value['translationDailyQuota'],
    'capabilities.translationDailyQuota',
  );
  const clientDownloadUrl = optionalNullableHttpsUrl(
    value['clientDownloadUrl'],
    'capabilities.clientDownloadUrl',
  );

  return {
    billingEnabled:
      optionalBoolean(value['billingEnabled'], 'capabilities.billingEnabled') ??
      DEFAULT_RUNTIME_CAPABILITIES.billingEnabled,
    emailInEnabled:
      optionalBoolean(value['emailInEnabled'], 'capabilities.emailInEnabled') ??
      DEFAULT_RUNTIME_CAPABILITIES.emailInEnabled,
    emailInRequiresPremium:
      optionalBoolean(value['emailInRequiresPremium'], 'capabilities.emailInRequiresPremium') ??
      DEFAULT_RUNTIME_CAPABILITIES.emailInRequiresPremium,
    cloudSyncRequiresPremium:
      optionalBoolean(value['cloudSyncRequiresPremium'], 'capabilities.cloudSyncRequiresPremium') ??
      DEFAULT_RUNTIME_CAPABILITIES.cloudSyncRequiresPremium,
    ttsCacheRequiresPremium:
      optionalBoolean(value['ttsCacheRequiresPremium'], 'capabilities.ttsCacheRequiresPremium') ??
      DEFAULT_RUNTIME_CAPABILITIES.ttsCacheRequiresPremium,
    bookFileUploadEnabled:
      optionalBoolean(value['bookFileUploadEnabled'], 'capabilities.bookFileUploadEnabled') ??
      DEFAULT_RUNTIME_CAPABILITIES.bookFileUploadEnabled,
    translationProviders: translationProviders ?? [
      ...DEFAULT_RUNTIME_CAPABILITIES.translationProviders,
    ],
    translationDailyQuota:
      translationDailyQuota === undefined
        ? DEFAULT_RUNTIME_CAPABILITIES.translationDailyQuota
        : translationDailyQuota,
    clientDownloadUrl: clientDownloadUrl ?? null,
  };
};

const validatePublicConfig = (
  serverBaseUrl: string,
  config: unknown,
  {
    allowInsecureHttp = isDevelopmentBuild(),
    requireSupabase = true,
  }: NormalizeUrlOptions & { requireSupabase?: boolean } = {},
): PublicReadestClientConfig => {
  assertNoDangerousSecrets(config);

  if (!isPlainObject(config)) {
    throw new CustomServerConfigError('invalid-config', 'Server config must be a JSON object.');
  }

  const apiBaseUrlValue = config['apiBaseUrl'];
  const supabaseUrlValue = config['supabaseUrl'];
  const supabaseAnonKeyValue = config['supabaseAnonKey'];
  const objectStorageTypeValue = config['objectStorageType'];
  const deploymentModeValue = config['deploymentMode'];

  const apiBaseUrl =
    typeof apiBaseUrlValue === 'string' && apiBaseUrlValue.trim()
      ? normalizeConfigUrl(apiBaseUrlValue, { allowInsecureHttp })
      : serverBaseUrl;

  const supabaseUrl =
    typeof supabaseUrlValue === 'string' && supabaseUrlValue.trim()
      ? normalizeConfigUrl(supabaseUrlValue, { allowInsecureHttp })
      : undefined;
  const supabaseAnonKey =
    typeof supabaseAnonKeyValue === 'string' && supabaseAnonKeyValue.trim()
      ? supabaseAnonKeyValue.trim()
      : undefined;

  if (supabaseAnonKey) validateSupabasePublicKey(supabaseAnonKey);

  if (requireSupabase && (!supabaseUrl || !supabaseAnonKey)) {
    throw new CustomServerConfigError(
      'missing-supabase-config',
      'Server config must include supabaseUrl and supabaseAnonKey.',
    );
  }

  if (
    deploymentModeValue !== undefined &&
    deploymentModeValue !== 'hosted' &&
    deploymentModeValue !== 'self-hosted'
  ) {
    throw new CustomServerConfigError(
      'invalid-config',
      'deploymentMode must be hosted or self-hosted.',
    );
  }

  return {
    apiBaseUrl,
    supabaseUrl,
    supabaseAnonKey,
    objectStorageType:
      typeof objectStorageTypeValue === 'string' && objectStorageTypeValue.trim()
        ? objectStorageTypeValue.trim()
        : undefined,
    storageFixedQuota: optionalNumber(config['storageFixedQuota'], 'storageFixedQuota'),
    translationFixedQuota: optionalNumber(config['translationFixedQuota'], 'translationFixedQuota'),
    deploymentMode: deploymentModeValue as ReadestDeploymentMode | undefined,
    capabilities: validateCapabilities(config['capabilities']),
  };
};

export const getCustomServerFetch = (fetchImpl?: typeof fetch): typeof fetch => {
  if (fetchImpl) return fetchImpl;
  if (isTauriClientBuild()) return tauriFetch as unknown as typeof fetch;
  if (!globalThis.fetch) {
    throw new CustomServerConfigError('server-not-reachable', 'Fetch API is not available.');
  }
  return globalThis.fetch.bind(globalThis);
};

export const parseRuntimeConfigScript = (source: string): unknown => {
  const match = source.match(/^\s*window\.__READEST_RUNTIME_CONFIG\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
  if (!match?.[1]) {
    throw new CustomServerConfigError(
      'invalid-config',
      'Runtime config script has an invalid envelope.',
    );
  }

  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    throw new CustomServerConfigError(
      'invalid-config',
      'Runtime config script contains invalid JSON.',
    );
  }
};

const fetchConfigSource = async (
  url: string,
  format: (typeof PUBLIC_CONFIG_SOURCES)[number]['format'],
  fetchImpl: typeof fetch,
  options: ResolveCustomServerConfigOptions,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: format === 'json' ? 'application/json' : 'application/javascript, text/javascript',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new CustomServerConfigError(
        'server-not-reachable',
        `Server config endpoint returned HTTP ${response.status}.`,
      );
    }

    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw new CustomServerConfigError('invalid-config', 'Server config response is too large.');
    }

    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > maxResponseBytes) {
      throw new CustomServerConfigError('invalid-config', 'Server config response is too large.');
    }

    if (format === 'script') return parseRuntimeConfigScript(source);
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new CustomServerConfigError(
        'invalid-config',
        'Server config response is not valid JSON.',
      );
    }
  } catch (error) {
    if (error instanceof CustomServerConfigError) throw error;
    if (controller.signal.aborted) {
      throw new CustomServerConfigError('request-timeout', 'Server config request timed out.');
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|\btls\b|\bssl\b/i.test(message)) {
      throw new CustomServerConfigError('tls-error', 'Server config TLS connection failed.');
    }
    throw new CustomServerConfigError('server-not-reachable', 'Server config request failed.');
  } finally {
    clearTimeout(timeout);
  }
};

const mergeSuggestedConfig = (
  previous: PublicReadestClientConfig,
  next: PublicReadestClientConfig,
): PublicReadestClientConfig => ({
  apiBaseUrl: next.apiBaseUrl ?? previous.apiBaseUrl,
  supabaseUrl: next.supabaseUrl ?? previous.supabaseUrl,
  supabaseAnonKey: next.supabaseAnonKey ?? previous.supabaseAnonKey,
});

export const fetchPublicClientConfig = async (
  serverBaseUrlInput: string,
  options: ResolveCustomServerConfigOptions = {},
) => {
  const serverBaseUrl = normalizeServerBaseUrl(serverBaseUrlInput, options);
  const fetchImpl = getCustomServerFetch(options.fetchImpl);

  let suggestedConfig: PublicReadestClientConfig = {};
  let hasSuggestedConfig = false;
  for (const source of PUBLIC_CONFIG_SOURCES) {
    try {
      const config = await fetchConfigSource(
        joinUrlPath(serverBaseUrl, source.path),
        source.format,
        fetchImpl,
        options,
      );
      const partialConfig = validatePublicConfig(serverBaseUrl, config, {
        ...options,
        requireSupabase: false,
      });
      suggestedConfig = mergeSuggestedConfig(suggestedConfig, partialConfig);
      hasSuggestedConfig = true;
      if (options.requireSupabase === false) return partialConfig;
      return validatePublicConfig(serverBaseUrl, config, options);
    } catch (error) {
      if (error instanceof CustomServerConfigError && error.code === 'dangerous-secret') {
        throw error;
      }
    }
  }

  throw new CustomServerConfigError(
    'manual-config-required',
    'Public client config is not discoverable.',
    hasSuggestedConfig ? suggestedConfig : undefined,
  );
};

export const resolveCustomServerConfig = async (
  serverBaseUrlInput: string,
  options: ResolveCustomServerConfigOptions = {},
): Promise<CustomServerConfig> => {
  const serverBaseUrl = normalizeServerBaseUrl(serverBaseUrlInput, options);
  const publicConfig = await fetchPublicClientConfig(serverBaseUrl, options);

  return {
    serverBaseUrl,
    apiBaseUrl: publicConfig.apiBaseUrl ?? serverBaseUrl,
    supabaseUrl: publicConfig.supabaseUrl,
    supabaseAnonKey: publicConfig.supabaseAnonKey,
    objectStorageType: publicConfig.objectStorageType,
    storageFixedQuota: publicConfig.storageFixedQuota,
    translationFixedQuota: publicConfig.translationFixedQuota,
    deploymentMode: publicConfig.deploymentMode,
    capabilities: publicConfig.capabilities,
    fetchedAt: options.now?.() ?? Date.now(),
  };
};

const fetchConnectivityProbe = async (
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  options: ResolveCustomServerConfigOptions,
  unreachableCode: 'api-unreachable' | 'supabase-unreachable',
) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CustomServerConfigError('request-timeout', 'Connection request timed out.');
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|\btls\b|\bssl\b/i.test(message)) {
      throw new CustomServerConfigError('tls-error', 'TLS connection failed.');
    }
    throw new CustomServerConfigError(unreachableCode, 'Connection request failed.');
  } finally {
    clearTimeout(timeout);
  }
};

export const validateCustomServerConnectivity = async (
  config: CustomServerConfig,
  options: ResolveCustomServerConfigOptions = {},
) => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new CustomServerConfigError(
      'missing-supabase-config',
      'Supabase URL and public key are required.',
    );
  }

  const fetchImpl = getCustomServerFetch(options.fetchImpl);
  const apiResponse = await fetchConnectivityProbe(
    joinUrlPath(config.apiBaseUrl, '/api/sync'),
    { method: 'GET', headers: { Accept: 'application/json' } },
    fetchImpl,
    options,
    'api-unreachable',
  );
  if (!apiResponse.ok && apiResponse.status !== 401 && apiResponse.status !== 403) {
    throw new CustomServerConfigError(
      'api-unreachable',
      `Readest API probe returned HTTP ${apiResponse.status}.`,
    );
  }

  const supabaseResponse = await fetchConnectivityProbe(
    joinUrlPath(config.supabaseUrl, '/auth/v1/settings'),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
    },
    fetchImpl,
    options,
    'supabase-unreachable',
  );
  if (!supabaseResponse.ok) {
    throw new CustomServerConfigError(
      'supabase-unreachable',
      `Supabase probe returned HTTP ${supabaseResponse.status}.`,
    );
  }
};

export const createManualCustomServerConfig = async (
  input: ManualCustomServerConfigInput,
  options: ResolveCustomServerConfigOptions = {},
): Promise<CustomServerConfig> => {
  const serverBaseUrl = normalizeServerBaseUrl(input.serverBaseUrl, options);
  const publicConfig = validatePublicConfig(
    serverBaseUrl,
    {
      apiBaseUrl: input.apiBaseUrl?.trim() || serverBaseUrl,
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey,
    },
    options,
  );
  const config: CustomServerConfig = {
    serverBaseUrl,
    apiBaseUrl: publicConfig.apiBaseUrl ?? serverBaseUrl,
    supabaseUrl: publicConfig.supabaseUrl,
    supabaseAnonKey: publicConfig.supabaseAnonKey,
    fetchedAt: options.now?.() ?? Date.now(),
  };

  await validateCustomServerConnectivity(config, options);
  return config;
};

const hasSameEffectiveServerConfig = (
  previous: CustomServerConfig | null,
  next: CustomServerConfig,
) =>
  previous !== null &&
  previous.serverBaseUrl === next.serverBaseUrl &&
  previous.apiBaseUrl === next.apiBaseUrl &&
  (previous.supabaseUrl ?? '') === (next.supabaseUrl ?? '') &&
  (previous.supabaseAnonKey ?? '') === (next.supabaseAnonKey ?? '');

export const saveCustomServerConfig = async (
  config: CustomServerConfig,
  { resetSession = false }: SaveCustomServerConfigOptions = {},
) => {
  const storage = getStorageAdapter();
  const previous = loadCustomServerConfig();
  storage?.setItem(CUSTOM_SERVER_CONFIG_KEY, JSON.stringify(config));

  if (resetSession && !hasSameEffectiveServerConfig(previous, config)) {
    const { clearAuthSessionForServerChange } = await import('@/helpers/auth');
    await clearAuthSessionForServerChange();
  }
};

export const refreshCustomServerConfig = async (
  options: ResolveCustomServerConfigOptions = {},
): Promise<CustomServerConfig | null> => {
  const current = loadCustomServerConfig();
  if (!current) return null;

  const refreshed = await resolveCustomServerConfig(current.serverBaseUrl, options);
  await saveCustomServerConfig(refreshed);
  return refreshed;
};

export const loadCustomServerConfig = (): CustomServerConfig | null => {
  const storage = getStorageAdapter();
  if (!storage) return null;

  const raw = storage.getItem(CUSTOM_SERVER_CONFIG_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return null;
    const serverBaseUrl = parsed['serverBaseUrl'];
    const apiBaseUrl = parsed['apiBaseUrl'];
    const fetchedAt = parsed['fetchedAt'];
    if (
      typeof serverBaseUrl !== 'string' ||
      typeof apiBaseUrl !== 'string' ||
      typeof fetchedAt !== 'number'
    ) {
      return null;
    }

    return {
      serverBaseUrl,
      apiBaseUrl,
      supabaseUrl:
        typeof parsed['supabaseUrl'] === 'string' ? (parsed['supabaseUrl'] as string) : undefined,
      supabaseAnonKey:
        typeof parsed['supabaseAnonKey'] === 'string'
          ? (parsed['supabaseAnonKey'] as string)
          : undefined,
      objectStorageType:
        typeof parsed['objectStorageType'] === 'string'
          ? (parsed['objectStorageType'] as string)
          : undefined,
      storageFixedQuota: optionalNumber(parsed['storageFixedQuota'], 'storageFixedQuota'),
      translationFixedQuota: optionalNumber(
        parsed['translationFixedQuota'],
        'translationFixedQuota',
      ),
      deploymentMode:
        parsed['deploymentMode'] === 'hosted' || parsed['deploymentMode'] === 'self-hosted'
          ? parsed['deploymentMode']
          : undefined,
      capabilities: validateCapabilities(parsed['capabilities']),
      fetchedAt,
    };
  } catch {
    return null;
  }
};

export const clearCustomServerConfig = async ({
  resetSession = false,
}: SaveCustomServerConfigOptions = {}) => {
  const previous = loadCustomServerConfig();
  const storage = getStorageAdapter();
  storage?.removeItem(CUSTOM_SERVER_CONFIG_KEY);

  if (resetSession && previous) {
    const { clearAuthSessionForServerChange } = await import('@/helpers/auth');
    await clearAuthSessionForServerChange();
  }
};

export const getCustomServerRuntimeConfig = (): PublicReadestClientConfig | null => {
  const config = loadCustomServerConfig();
  if (!config) return null;
  return {
    apiBaseUrl: config.apiBaseUrl,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    objectStorageType: config.objectStorageType,
    storageFixedQuota: config.storageFixedQuota,
    translationFixedQuota: config.translationFixedQuota,
    deploymentMode: config.deploymentMode,
    capabilities: config.capabilities,
  };
};

export const getCustomServerConfigStorageKey = () => CUSTOM_SERVER_CONFIG_KEY;
