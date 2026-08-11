import crypto from 'node:crypto';

export const PROXY_PROFILE_PROTOCOL = 'consensus.proxy-profile' as const;
export const PROXY_PROFILE_VERSION = 1 as const;

export interface ProxyExecutionProfileV1 {
  protocol: typeof PROXY_PROFILE_PROTOCOL;
  version: typeof PROXY_PROFILE_VERSION;
  base_url: string;
  allowed_methods: string[];
  allowed_paths: string[];
  cache_ttl: number;
  verbose: boolean;
  node_region?: string;
  node_domain?: string;
  node_exclude?: string;
  direct: boolean;
}

const PROFILE_KEYS = new Set([
  'protocol',
  'version',
  'base_url',
  'allowed_methods',
  'allowed_paths',
  'cache_ttl',
  'verbose',
  'node_region',
  'node_domain',
  'node_exclude',
  'direct',
]);
const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const METHODS = new Set(METHOD_ORDER);
const MAX_PATHS = 64;
const MAX_CACHE_TTL_SECONDS = 3_600;
const MAX_PREFERENCE_LENGTH = 256;
const PROFILE_CONTROL_HEADERS = new Set([
  'x-cache-ttl', 'x-verbose', 'x-node-region', 'x-node-domain', 'x-node-exclude', 'x-direct',
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]): [string, unknown] => [key, stableValue(item)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return value;
}

function normalizePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new TypeError(`${field} must be an origin-relative path beginning with /`);
  }
  const parsed = new URL(value, 'http://profile.local');
  if (parsed.origin !== 'http://profile.local' || parsed.search || parsed.hash) {
    throw new TypeError(`${field} must not contain an origin, query, or fragment`);
  }
  return parsed.pathname;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function optionalPreference(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.split(',').map((item) => item.trim()).filter(Boolean).join(',');
  if (!normalized || normalized.length > MAX_PREFERENCE_LENGTH) {
    throw new TypeError(`${field} must contain 1-${MAX_PREFERENCE_LENGTH} characters`);
  }
  return normalized;
}

/** Validate and canonicalize the anonymous execution plan carried on the wire. */
export function normalizeProxyProfileV1(input: unknown): ProxyExecutionProfileV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('proxy profile must be an object');
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!PROFILE_KEYS.has(key)) throw new TypeError(`unsupported proxy profile field: ${key}`);
  }
  if (value.protocol !== PROXY_PROFILE_PROTOCOL || value.version !== PROXY_PROFILE_VERSION) {
    throw new TypeError(`unsupported proxy profile protocol/version; expected ${PROXY_PROFILE_PROTOCOL}@${PROXY_PROFILE_VERSION}`);
  }

  let base: URL;
  try {
    base = new URL(String(value.base_url ?? ''));
  } catch {
    throw new TypeError('proxy profile base_url is invalid');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('proxy profile base_url must be an http(s) URL without credentials, query, or fragment');
  }
  base.pathname = base.pathname === '/' ? '/' : base.pathname.replace(/\/+$/, '');

  if (!Array.isArray(value.allowed_methods) || value.allowed_methods.length === 0) {
    throw new TypeError('proxy profile allowed_methods must be a non-empty array');
  }
  const methodSet = new Set(value.allowed_methods.map((method) => String(method).toUpperCase()));
  if ([...methodSet].some((method) => !METHODS.has(method))) {
    throw new TypeError('proxy profile contains an unsupported HTTP method');
  }
  const allowedMethods = METHOD_ORDER.filter((method) => methodSet.has(method));

  if (!Array.isArray(value.allowed_paths) || value.allowed_paths.length === 0 || value.allowed_paths.length > MAX_PATHS) {
    throw new TypeError(`proxy profile allowed_paths must contain 1-${MAX_PATHS} entries`);
  }
  const allowedPaths = [...new Set(
    value.allowed_paths.map((path) => normalizePath(path, 'proxy profile allowed_paths entry')),
  )].sort();

  let cacheTtl = 300;
  if (value.cache_ttl !== undefined) {
    cacheTtl = Number(value.cache_ttl);
    if (!Number.isInteger(cacheTtl) || cacheTtl < 1 || cacheTtl > MAX_CACHE_TTL_SECONDS) {
      throw new TypeError(`proxy profile cache_ttl must be an integer from 1-${MAX_CACHE_TTL_SECONDS}`);
    }
  }

  return {
    protocol: PROXY_PROFILE_PROTOCOL,
    version: PROXY_PROFILE_VERSION,
    base_url: base.toString(),
    allowed_methods: allowedMethods,
    allowed_paths: allowedPaths,
    cache_ttl: cacheTtl,
    verbose: optionalBoolean(value.verbose, 'proxy profile verbose') ?? false,
    ...(value.node_region === undefined ? {} : { node_region: optionalPreference(value.node_region, 'proxy profile node_region')! }),
    ...(value.node_domain === undefined ? {} : { node_domain: optionalPreference(value.node_domain, 'proxy profile node_domain')! }),
    ...(value.node_exclude === undefined ? {} : { node_exclude: optionalPreference(value.node_exclude, 'proxy profile node_exclude')! }),
    direct: optionalBoolean(value.direct, 'proxy profile direct') ?? true,
  };
}

export function hashProxyProfileV1(input: unknown): string {
  const profile = normalizeProxyProfileV1(input);
  return hashNormalizedProfile(profile);
}

function hashNormalizedProfile(profile: ProxyExecutionProfileV1): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(profile))).digest('hex');
}

/** Enforce the profile independently at every execution boundary. */
export function assertProxyProfileRequestV1(
  input: unknown,
  targetUrl: string,
  method: string,
): ProxyExecutionProfileV1 {
  const profile = normalizeProxyProfileV1(input);
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new TypeError('proxy profile target_url is invalid');
  }
  const base = new URL(profile.base_url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError('proxy profile target must use http(s)');
  }
  if (target.username || target.password || target.hash) {
    throw new TypeError('proxy profile target cannot contain credentials or a fragment');
  }
  if (target.origin !== base.origin) throw new TypeError('proxy profile target is outside its configured origin');

  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new TypeError('proxy profile target is outside its configured base path');
  }
  const relativePath = target.pathname.slice(basePath.length) || '/';
  const allowedPath = profile.allowed_paths.some((prefix) =>
    prefix === '/' || relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
  if (!allowedPath) throw new TypeError('proxy profile target path is not allowed');

  const normalizedMethod = method.toUpperCase();
  if (!profile.allowed_methods.includes(normalizedMethod)) {
    throw new TypeError(`method ${normalizedMethod} is not allowed by the proxy profile`);
  }
  return profile;
}

/** Existing control headers remain the v1 execution adapter for cache and routing. */
export function proxyProfileControlHeadersV1(input: unknown): Record<string, string> {
  const profile = normalizeProxyProfileV1(input);
  return controlHeadersForNormalizedProfile(profile);
}

function controlHeadersForNormalizedProfile(profile: ProxyExecutionProfileV1): Record<string, string> {
  return {
    ...(profile.cache_ttl === undefined ? {} : { 'x-cache-ttl': String(profile.cache_ttl) }),
    ...(profile.verbose === true ? { 'x-verbose': 'true' } : {}),
    ...(profile.node_region === undefined ? {} : { 'x-node-region': profile.node_region }),
    ...(profile.node_domain === undefined ? {} : { 'x-node-domain': profile.node_domain }),
    ...(profile.node_exclude === undefined ? {} : { 'x-node-exclude': profile.node_exclude }),
    ...(profile.direct === true ? { 'x-direct': 'true' } : {}),
  };
}

export interface PreparedProxyProfileV1 {
  profile: ProxyExecutionProfileV1;
  profile_hash: string;
  headers: Record<string, string>;
}

/** Canonicalize, enforce, hash, and apply a profile in one operation. */
export function prepareProxyProfileRequestV1(
  input: unknown,
  targetUrl: string,
  method: string,
  headers: Record<string, string> = {},
): PreparedProxyProfileV1 {
  const profile = assertProxyProfileRequestV1(input, targetUrl, method);
  const requestHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => !PROFILE_CONTROL_HEADERS.has(key.toLowerCase()))
      .map(([key, value]) => [key, String(value)]),
  );
  return {
    profile,
    profile_hash: hashNormalizedProfile(profile),
    headers: { ...requestHeaders, ...controlHeadersForNormalizedProfile(profile) },
  };
}
