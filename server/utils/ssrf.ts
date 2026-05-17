import dns from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

interface DnsCacheEntry { isPrivate: boolean; expiresAt: number; }
const DNS_CACHE     = new Map<string, DnsCacheEntry>();
const DNS_TTL_MS    = 30_000;
const DNS_NEG_TTL   = 5_000;
const DNS_CACHE_MAX = 5_000;

function cacheSet(hostname: string, entry: DnsCacheEntry): void {
  // Map iteration order is insertion order, so the first key is the oldest.
  // Evict in a loop to keep the size below the cap even if multiple stale
  // entries linger (e.g. after a TTL refresh re-adds an existing key).
  while (DNS_CACHE.size >= DNS_CACHE_MAX) {
    const oldest = DNS_CACHE.keys().next().value;
    if (oldest === undefined) break;
    DNS_CACHE.delete(oldest);
  }
  // Re-insert to move to the end (most-recent) of the iteration order.
  DNS_CACHE.delete(hostname);
  DNS_CACHE.set(hostname, entry);
}

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

export async function isPrivateTarget(urlString: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(urlString); } catch { return true; }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.hostname !== decodeURIComponent(parsed.hostname)) return true;

  const hostname = parsed.hostname.toLowerCase();
  const bare     = hostname.replace(/^\[|\]$/g, '');

  if (bare === '::1')                    return true;
  if (/^fe80:/i.test(bare))             return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true;

  const normalized = normalizeToIPv4(bare);
  if (normalized !== null) {
    return isPrivateIPv4(normalized);
  }

  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiresAt) return cached.isPrivate;

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    let isPrivate = false;
    for (const { address, family } of records) {
      if (family === 4) {
        if (isPrivateIPv4(address)) { isPrivate = true; break; }
      } else if (family === 6) {
        const addr = address.toLowerCase();
        if (
          addr === '::1'                    ||
          /^fe80:/i.test(addr)              ||
          /^f[cd][0-9a-f]{2}:/i.test(addr) ||
          (normalizeToIPv4(addr) !== null && isPrivateIPv4(normalizeToIPv4(addr)!))
        ) { isPrivate = true; break; }
      }
    }
    cacheSet(hostname, { isPrivate, expiresAt: Date.now() + DNS_TTL_MS });
    return isPrivate;
  } catch {
    cacheSet(hostname, { isPrivate: true, expiresAt: Date.now() + DNS_NEG_TTL });
    return true;
  }
}
