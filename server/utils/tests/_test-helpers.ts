/**
 * Shared test helpers.
 *
 * `noSsrf` is the SSRF override every server test should pass into
 * `new ConsensusProxy({ ssrfCheck: noSsrf })`. It returns a synthetic
 * SafeResolution with `isLiteral: true` so the proxy uses the URL as-is —
 * required for local upstreams on 127.0.0.1 / ::1 that the real guard would
 * otherwise refuse.
 */

import type { SafeResolution } from '../ssrf.ts';

export async function noSsrf(target_url: string): Promise<SafeResolution> {
  const u = new URL(target_url);
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  const family = bare.includes(':') ? 6 : 4;
  return { ip: bare, family, hostname: bare, isLiteral: true };
}
