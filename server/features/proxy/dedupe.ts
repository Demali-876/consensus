// Canonical request → dedupe-key derivation. Extracted from proxy.ts so the
// orchestrator (which issues tickets) and the node (which recomputes the key to
// verify a ticket's `sub` request-binding) share ONE implementation. The wire
// format is locked by dedupe.vectors.json. Pure; only depends on node:crypto,
// so consensus-node mirrors this file verbatim.

import crypto from 'node:crypto';

export type RequestBody = string | Buffer | Record<string, unknown> | unknown[] | null | undefined;
export type Headers = Record<string, string>;

export interface DedupeParams {
  target_url: string;
  method: string;
  headers?: Headers;
  body?: RequestBody;
  profile_hash?: string;
}

const ALLOW_HEADERS = new Set(['accept', 'content-type']);
const HASH_HEADERS = new Set(['authorization', 'cookie']);
const MULTI_SPACE = /\s+/g;

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]): [string, unknown] => [k, deepSort(v)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(deepSort(value));
}

export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw); // throws TypeError for invalid URLs — callers must validate first
  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === 'https:' && u.port === '443') ||
    (u.protocol === 'http:' && u.port === '80')
  )
    u.port = '';

  const params = [...u.searchParams.entries()].sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

export function canonicalizeSemanticHeaders(headers: Headers): Headers {
  // Collect public semantic values plus hashes of sensitive upstream credentials,
  // then emit in fixed alphabetical order. Secrets never enter the canonical form.
  const result: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase(); // HTTP names have no surrounding whitespace
    if (ALLOW_HEADERS.has(lower)) result[lower] = v.trim().replace(MULTI_SPACE, ' ');
    else if (HASH_HEADERS.has(lower)) result[lower] = sha256Hex(v);
  }
  const ordered: Headers = {};
  if (result['accept']) ordered['accept'] = result['accept'];
  if (result['authorization']) ordered['authorization'] = result['authorization'];
  if (result['content-type']) ordered['content-type'] = result['content-type'];
  if (result['cookie']) ordered['cookie'] = result['cookie'];
  return ordered;
}

export function computeBodyHash(body: RequestBody): string {
  if (body === undefined || body === null) return 'no-body';
  if (Buffer.isBuffer(body)) return sha256Hex(body);
  if (typeof body === 'string') return sha256Hex(body);
  return sha256Hex(stableStringify(body));
}

export function generateDedupeKey({ target_url, method, headers = {}, body, profile_hash }: DedupeParams): string {
  const semanticHeaders = canonicalizeSemanticHeaders(headers);
  const canonical = {
    v: 1,
    scope: 'global',
    method: method.toUpperCase(),
    url: canonicalizeUrl(target_url),
    headers: semanticHeaders,
    body_hash: computeBodyHash(body),
    profile_hash: profile_hash || undefined,
  };

  return sha256Hex(stableStringify(canonical));
}
