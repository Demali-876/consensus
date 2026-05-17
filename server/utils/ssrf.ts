import dns from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returned by resolveAndCheckTarget() for every URL that passes the SSRF check.
 * Callers must bind the outgoing TCP connection to `ip` (via a custom lookup or
 * URL rewrite) so no second DNS query is ever made — closing the TOCTOU window.
 */
export interface SafeResolution {
  /** Verified non-private IPv4 dotted-decimal or raw IPv6 string. */
  ip:        string;
  family:    4 | 6;
  /** Original hostname as it appeared in the URL — needed for Host header & TLS SNI. */
  hostname:  string;
  /** True when the URL contained a literal IP address; no DNS was performed. */
  isLiteral: boolean;
}

interface DnsCacheEntry {
  isPrivate: boolean;
  ip?:       string;   // first verified-safe address; present only when isPrivate === false
  family?:   4 | 6;
  expiresAt: number;
}

const DNS_CACHE   = new Map<string, DnsCacheEntry>();
const DNS_TTL_MS  = 30_000;
const DNS_NEG_TTL = 5_000;

function normalizeToIPv4(raw: string): string | null {
  const s = raw.replace(/^\[|\]$/g, '').toLowerCase();

  const m1 = s.match(/^(?:0{1,4}:){5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
           ?? s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m1) return m1[1]!;

  const m2 = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m2) {
    const hi = parseInt(m2[1]!, 16);
    const lo = parseInt(m2[2]!, 16);
    return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  }

  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  if (!parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*|0)$/.test(p))) return null;

  const nums = parts.map((p) =>
    parseInt(p, p.startsWith('0x') ? 16 : p.startsWith('0') && p.length > 1 ? 8 : 10),
  );
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  let ip32: number;
  if (parts.length === 1) {
    if (nums[0]! > 0xffffffff) return null;
    ip32 = nums[0]!;
  } else if (parts.length === 2) {
    if (nums[0]! > 0xff || nums[1]! > 0xffffff) return null;
    ip32 = (nums[0]! << 24) | nums[1]!;
  } else if (parts.length === 3) {
    if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xffff) return null;
    ip32 = (nums[0]! << 24) | (nums[1]! << 16) | nums[2]!;
  } else {
    if (nums.some((n) => n! > 0xff)) return null;
    ip32 = (nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!;
  }

  return [(ip32 >>> 24) & 0xff, (ip32 >>> 16) & 0xff, (ip32 >>> 8) & 0xff, ip32 & 0xff].join('.');
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 127                         ||
    a === 0                           ||
    a === 10                          ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)          ||
    (a === 169 && b === 254)          ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// `bare` must already be lowercased and bracket-stripped.
function isPrivateIPv6Bare(bare: string): boolean {
  if (bare === '::1') return true;
  if (/^fe80:/i.test(bare)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true;
  const mapped = normalizeToIPv4(bare);
  return mapped !== null && isPrivateIPv4(mapped);
}

const FORBIDDEN = 'Forbidden target_url — private/internal addresses are not allowed';

/**
 * Resolves and validates a URL target.  Throws TypeError for every forbidden
 * case (invalid URL, disallowed protocol, private address, DNS failure).
 *
 * The returned SafeResolution contains the verified IP address.  Callers MUST
 * bind the outgoing TCP connection to that IP — do not let the HTTP stack
 * re-resolve the hostname — so the SSRF check and the actual connection share
 * a single DNS result with no TOCTOU window between them.
 */
export async function resolveAndCheckTarget(urlString: string): Promise<SafeResolution> {
  let parsed: URL;
  try { parsed = new URL(urlString); } catch { throw new TypeError(FORBIDDEN); }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new TypeError(FORBIDDEN);
  if (parsed.hostname !== decodeURIComponent(parsed.hostname)) throw new TypeError(FORBIDDEN);

  const hostname = parsed.hostname.toLowerCase();
  const bare     = hostname.replace(/^\[|\]$/g, '');

  // IPv6 literal — check private ranges before touching DNS
  if (isPrivateIPv6Bare(bare)) throw new TypeError(FORBIDDEN);

  // IPv4 literal (or IPv6-mapped variant) — no DNS needed
  const normalized = normalizeToIPv4(bare);
  if (normalized !== null) {
    if (isPrivateIPv4(normalized)) throw new TypeError(FORBIDDEN);
    return { ip: normalized, family: 4, hostname: normalized, isLiteral: true };
  }

  // Hostname — serve from cache when still fresh
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiresAt) {
    if (cached.isPrivate || !cached.ip) throw new TypeError(FORBIDDEN);
    return { ip: cached.ip, family: cached.family!, hostname, isLiteral: false };
  }

  // DNS resolution — check every record; reject if any is private
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });

    let safeIp:     string | undefined;
    let safeFamily: 4 | 6  | undefined;
    let anyPrivate = false;

    for (const { address, family } of records) {
      if (family === 4) {
        if (isPrivateIPv4(address)) { anyPrivate = true; }
        else if (!safeIp)           { safeIp = address; safeFamily = 4; }
      } else if (family === 6) {
        if (isPrivateIPv6Bare(address.toLowerCase())) { anyPrivate = true; }
        else if (!safeIp)                             { safeIp = address; safeFamily = 6; }
      }
    }

    if (anyPrivate || !safeIp) {
      DNS_CACHE.set(hostname, { isPrivate: true, expiresAt: Date.now() + DNS_TTL_MS });
      throw new TypeError(FORBIDDEN);
    }

    DNS_CACHE.set(hostname, { isPrivate: false, ip: safeIp, family: safeFamily, expiresAt: Date.now() + DNS_TTL_MS });
    return { ip: safeIp, family: safeFamily!, hostname, isLiteral: false };

  } catch (err) {
    if (err instanceof TypeError) throw err;
    // DNS failure — fail closed (treat as private)
    DNS_CACHE.set(hostname, { isPrivate: true, expiresAt: Date.now() + DNS_NEG_TTL });
    throw new TypeError(FORBIDDEN);
  }
}

/** Backward-compatible boolean wrapper kept for existing call sites and tests. */
export async function isPrivateTarget(urlString: string): Promise<boolean> {
  try { await resolveAndCheckTarget(urlString); return false; }
  catch { return true; }
}
