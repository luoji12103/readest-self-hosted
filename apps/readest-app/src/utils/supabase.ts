import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRuntimeConfig } from '@/services/runtimeConfig';

const decodeRequiredBase64 = (value: string | undefined) => (value ? atob(value) : '');

// supabase-js persists the session under a key derived from the URL's first
// host label. Readest Cloud keeps the key from its original host so moving the
// client to another of its hosts doesn't sign everyone out.
const READEST_CLOUD_HOSTS = [
  'readest.supabase.co',
  'vbsyxfusjjqdxkjqlysc.supabase.co',
  'auth.readest.com',
];

// Some ISPs block *.supabase.co (#6416), so Readest Cloud sends password sign-in
// and the calls that keep such a session alive through a Worker on readest.com
// (workers/auth-proxy). OAuth and email links stay on the Supabase host: their
// callbacks land there, and a proxy can't change that.
const AUTH_PROXY_URL = 'https://auth-cf.readest.com';

const isProxiedAuthRequest = ({ pathname, searchParams }: URL) =>
  pathname === '/auth/v1/logout' ||
  (pathname === '/auth/v1/token' &&
    ['password', 'refresh_token'].includes(searchParams.get('grant_type') ?? ''));

const proxyAuthFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return isProxiedAuthRequest(url)
    ? fetch(`${AUTH_PROXY_URL}${url.pathname}${url.search}`, init)
    : fetch(input, init);
};

const getSupabasePublicConfig = () => {
  const runtimeConfig = getRuntimeConfig();
  return {
    supabaseUrl:
      runtimeConfig?.supabaseUrl ||
      process.env['SUPABASE_URL'] ||
      process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
      decodeRequiredBase64(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64']),
    supabaseAnonKey:
      runtimeConfig?.supabaseAnonKey ||
      process.env['SUPABASE_ANON_KEY'] ||
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
      decodeRequiredBase64(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64']),
  };
};

let cachedPublicClient: SupabaseClient | null = null;
let cachedPublicClientKey = '';

export const getSupabaseClient = () => {
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  const cacheKey = `${supabaseUrl}\n${supabaseAnonKey}`;
  if (!cachedPublicClient || cachedPublicClientKey !== cacheKey) {
    cachedPublicClient = createClient(
      supabaseUrl,
      supabaseAnonKey,
      READEST_CLOUD_HOSTS.includes(new URL(supabaseUrl).hostname)
        ? { auth: { storageKey: 'sb-readest-auth-token' }, global: { fetch: proxyAuthFetch } }
        : undefined,
    );
    cachedPublicClientKey = cacheKey;
  }
  return cachedPublicClient;
};

export const resetSupabaseClientCache = () => {
  cachedPublicClient = null;
  cachedPublicClientKey = '';
};

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(getSupabaseClient(), property, receiver);
    return typeof value === 'function' ? value.bind(getSupabaseClient()) : value;
  },
});

export const createSupabaseClient = (accessToken?: string) => {
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {},
    },
  });
};

export const createSupabaseAdminClient = () => {
  const { supabaseUrl } = getSupabasePublicConfig();
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
