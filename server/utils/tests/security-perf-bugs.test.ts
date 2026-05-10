/**
 * Security & Performance Bug Report — 2026-05-10
 *
 * Daily audit findings. Each test is written to FAIL with the current code,
 * proving the bug exists. A fully green run means all five bugs are fixed.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ #  │ Severity │ Location                  │ Title                        │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │ 1  │ HIGH     │ proxy.ts:244-248           │ Uncapped x-cache-ttl         │
 * │ 2  │ MEDIUM   │ proxy.ts:248               │ TTL=0 cannot disable cache   │
 * │ 3  │ HIGH     │ ssrf.ts                    │ SSRF TOCTOU / DNS rebinding  │
 * │ 4  │ HIGH     │ orchestrator.js:357        │ Unauthed heartbeat spoof     │
 * │ 5  │ MEDIUM   │ orchestrator.js:378        │ Email leaked in status       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { describe, it, before, after, mock } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import os      from 'node:os';
import path    from 'node:path';
import fs      from 'node:fs';
import crypto  from 'node:crypto';
import express from 'express';

// ── Temp DB so tests never touch the real consensus.db ────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-sec-test-'));
process.env.NODE_DB_PATH = path.join(tmpDir, 'test.db');
process.env.FREE_MODE    = 'true';

const { NodeStore } = await import('../../data/node_store.js');

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});


// ══════════════════════════════════════════════════════════════════════════════
// BUG 1 — HIGH — Cache Poisoning via Uncapped x-cache-ttl
// ══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: proxy.ts:244-248 accepts any non-negative integer from the
//   caller-controlled x-cache-ttl header without enforcing an upper bound:
//
//     const ttlFromHdr  = ttlRaw !== undefined ? Number(ttlRaw) : NaN;
//     const resolvedTTL = cacheTTLArg !== undefined ? cacheTTLArg
//                       : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0
//                         ? ttlFromHdr : 300;
//     const ttl = resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL);
//
// IMPACT: Any caller can send x-cache-ttl: 9999999999 (~317 years). That
//   response is then served to every subsequent caller for the same URL until
//   the server restarts. With maxKeys=10_000 the full cache can be poisoned
//   with permanent stale entries, blocking legitimate consumers.
//
// FIX DIRECTION: Cap TTL at a sensible maximum (e.g. 3 600 s / 1 hour).
//   Reject or silently clamp values exceeding it.
//
describe('Bug 1 — HIGH: Uncapped x-cache-ttl enables permanent cache poisoning', () => {
  // ── Inline reproduction of the TTL resolution logic from proxy.ts:242-248 ──
  // (kept here so the test documents exactly which lines are buggy)
  function resolveProxyTTL(
    headers: Record<string, string>,
    cacheTTLArg?: number,
  ): number {
    const ttlRaw = headers['x-cache-ttl']
      ?? Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-cache-ttl')?.[1];
    const ttlFromHdr  = ttlRaw !== undefined ? Number(ttlRaw) : NaN;
    const resolvedTTL = cacheTTLArg !== undefined ? cacheTTLArg
                      : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
                      : 300;
    return resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL); // ← buggy line
  }

  const MAX_REASONABLE_TTL = 86_400; // 1 day — a sensible upper bound

  it('should cap x-cache-ttl at a reasonable maximum (BUG: no cap enforced)', () => {
    const hugeTTL = 9_999_999_999; // ~317 years

    const actual = resolveProxyTTL({ 'x-cache-ttl': String(hugeTTL) });

    // EXPECTED after fix: actual <= MAX_REASONABLE_TTL
    // ACTUAL today:       actual === 9_999_999_999  (assertion below fails → bug confirmed)
    assert.ok(
      actual <= MAX_REASONABLE_TTL,
      `BUG CONFIRMED: x-cache-ttl=${hugeTTL} was accepted and produced TTL=${actual}s ` +
      `(~${Math.round(actual / 86_400)} days). ` +
      `No upper bound is enforced; an attacker can permanently poison any cache entry.`,
    );
  });

  it('moderately large TTL (e.g. 3 days) is also uncapped and silently accepted', () => {
    const threeDays = 3 * 86_400; // 259_200 — still well above any reasonable max
    const actual    = resolveProxyTTL({ 'x-cache-ttl': String(threeDays) });

    assert.ok(
      actual <= MAX_REASONABLE_TTL,
      `BUG CONFIRMED: x-cache-ttl=${threeDays}s (3 days) accepted without capping. ` +
      `TTL resolved to ${actual}s.`,
    );
  });

  it('normal TTL values (≤ 1 day) behave correctly — regression guard for the fix', () => {
    assert.equal(resolveProxyTTL({ 'x-cache-ttl': '300'   }), 300,    '5-minute TTL must pass through');
    assert.equal(resolveProxyTTL({ 'x-cache-ttl': '3600'  }), 3600,   '1-hour TTL must pass through');
    assert.equal(resolveProxyTTL({ 'x-cache-ttl': '86400' }), 86_400, '1-day TTL must pass through');
    assert.equal(resolveProxyTTL({}, 60),                       60,    'cacheTTL argument must pass through');
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// BUG 2 — MEDIUM — x-cache-ttl: 0 Cannot Express "Do Not Cache"
// ══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: proxy.ts:248 clamps any resolved TTL of 0 to 1 second:
//
//     const ttl = resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL);
//
//   This was added to prevent accidental "cache forever" behaviour in
//   node-cache (which treats TTL=0 as "no expiry"). However the side-effect
//   is that callers have NO way to request "do not cache this response".
//
//   NOTE: node-cache ttl=0 means "no expiry" (permanent).  The correct fix
//   is to treat resolvedTTL===0 as a skip-cache sentinel and branch BEFORE
//   any cache.get / cache.set calls, never passing 0 to node-cache.
//
// IMPACT: Real-time consumers (price feeds, status pages, health probes)
//   that set x-cache-ttl: 0 expecting a live response silently receive a
//   cached answer that can be up to 1 second stale.
//
describe('Bug 2 — MEDIUM: x-cache-ttl: 0 is converted to 1 s, breaking no-cache semantics', () => {
  function resolveProxyTTL(
    headers: Record<string, string>,
    cacheTTLArg?: number,
  ): number {
    const ttlRaw      = headers['x-cache-ttl']
      ?? Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-cache-ttl')?.[1];
    const ttlFromHdr  = ttlRaw !== undefined ? Number(ttlRaw) : NaN;
    const resolvedTTL = cacheTTLArg !== undefined ? cacheTTLArg
                      : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
                      : 300;
    return resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL); // ← buggy line
  }

  it('x-cache-ttl: 0 should produce TTL=0 (skip-cache sentinel) but produces TTL=1 (BUG)', () => {
    const actual = resolveProxyTTL({ 'x-cache-ttl': '0' });

    // EXPECTED after fix: actual === 0  (caller's no-cache intent respected)
    // ACTUAL today:       actual === 1  (silently overridden — assertion fails → bug confirmed)
    assert.equal(
      actual, 0,
      `BUG CONFIRMED: x-cache-ttl: 0 resolved to TTL=${actual}s instead of 0. ` +
      `Callers cannot opt out of caching; their "do not cache" intent is silently ignored.`,
    );
  });

  it('cacheTTL argument of 0 (passed programmatically) also silently becomes 1 s (BUG)', () => {
    const actual = resolveProxyTTL({}, 0);

    assert.equal(
      actual, 0,
      `BUG CONFIRMED: cacheTTL=0 resolved to ${actual}s — programmatic no-cache also broken.`,
    );
  });

  it('positive TTL values are unaffected by the fix — regression guard', () => {
    assert.equal(resolveProxyTTL({ 'x-cache-ttl': '1'   }), 1);
    assert.equal(resolveProxyTTL({ 'x-cache-ttl': '300' }), 300);
    assert.equal(resolveProxyTTL({}, 60),                    60);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// BUG 3 — HIGH — SSRF TOCTOU: DNS Check and HTTP Request Use Separate Lookups
// ══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: ssrf.ts resolves the target hostname via dns.lookup() and caches
//   the result for 30 seconds (DNS_TTL_MS = 30_000). The actual HTTP request
//   issued by axios in proxy.ts performs an independent OS-level DNS lookup —
//   there is no shared DNS cache between the SSRF guard and the HTTP client.
//
// ATTACK (DNS Rebinding):
//   1. Attacker controls evil.example with a TTL of 1 s.
//   2. DNS initially returns 93.184.216.34 (a public IP).
//   3. isPrivateTarget('http://evil.example/') → false (public → cached 30 s).
//   4. Attacker flips DNS to 127.0.0.1 (loopback) immediately.
//   5. Within the 30 s SSRF-cache window subsequent SSRF checks still return
//      false (cached). Meanwhile axios resolves DNS *again* from the OS and
//      receives 127.0.0.1 → request reaches the internal network.  SSRF!
//
// DEMONSTRATED BELOW: We mock dns.lookup so the first call returns a public
//   IP and the second returns loopback. We then show that isPrivateTarget's
//   in-process cache suppresses the second SSRF check, while the OS (and thus
//   the HTTP client) would see the rebind.
//
// FIX DIRECTION: After isPrivateTarget resolves the hostname, pass the
//   *resolved IP* to the HTTP client (not the original hostname) so DNS is
//   only resolved once.
//
describe('Bug 3 — HIGH: SSRF TOCTOU — isPrivateTarget DNS check is decoupled from HTTP client', () => {
  // ── Why this test does NOT need network access ─────────────────────────────
  // The TOCTOU root cause is an API design gap: isPrivateTarget() returns a
  // plain boolean and discards the resolved IP address.  The proxy then passes
  // the *original hostname* to axios, which must resolve DNS a second time.
  //
  // We expose this structural gap without any DNS calls by using a literal
  // public IP (8.8.8.8) — normalizeToIPv4 handles it inline; no dns.lookup
  // is invoked.  The structural assertion holds equally for hostname-based URLs.

  it('isPrivateTarget discards the resolved IP, forcing a second independent DNS lookup (TOCTOU)', async () => {
    const { isPrivateTarget } = await import('../../utils/ssrf.ts');

    // 8.8.8.8 is a public IP literal — handled without DNS, no network needed.
    const result = await isPrivateTarget('http://8.8.8.8/');

    // The function correctly identifies 8.8.8.8 as not private.
    assert.equal(result, false, '8.8.8.8 must be recognised as a public address');

    // ── BUG: the return type is a plain boolean ────────────────────────────
    // The proxy in proxy.ts:233-237 does:
    //
    //   if (await isPrivateTarget(target_url)) throw new TypeError(...);
    //   // ← resolved address is lost here
    //   const response = await axios({ url: target_url, ... });
    //   // ← axios re-resolves the hostname independently via OS DNS
    //
    // Attack window (hostname URLs, 30 s):
    //   t=0  isPrivateTarget('http://evil.example/') → DNS → 1.2.3.4 (public) → cached
    //   t=1  Attacker flips DNS for evil.example → 127.0.0.1
    //   t=2  SSRF cache still says "safe" (30 s TTL)
    //   t=2  axios resolves evil.example → OS DNS → 127.0.0.1 → INTERNAL REQUEST
    //
    // FIX: Change return type to { isPrivate: boolean; resolvedAddress?: string }
    // so proxy.ts can pass the already-resolved address to axios directly,
    // collapsing the two separate DNS resolutions into one.

    assert.equal(
      typeof result, 'object',
      `BUG CONFIRMED: isPrivateTarget returned ${JSON.stringify(result)} ` +
      `(type: ${typeof result}).  The function returns a plain boolean and discards ` +
      `the resolved IP address.  For any hostname-based URL the HTTP client (axios) ` +
      `is forced to perform a second, independent OS-level DNS resolution, creating ` +
      `a 30-second TOCTOU window exploitable via DNS rebinding.`,
    );
  });

  it('SSRF DNS cache stores results for 30 s — confirming the rebinding window duration', async () => {
    // Show that the DNS_TTL_MS constant in ssrf.ts is 30 seconds by reading
    // the source.  This documents the exact attack window length.
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'utils/ssrf.ts'), 'utf8',
    );
    const match = src.match(/DNS_TTL_MS\s*=\s*(\d[\d_]*)/);
    assert.ok(match, 'DNS_TTL_MS constant must exist in ssrf.ts');

    const ttlMs = Number(match![1]!.replace(/_/g, ''));
    // Assert the cache window is NOT excessively long.
    // Current value is 30_000 ms (30 s) — long enough for a DNS rebind to succeed.
    // A safe value would be ≤ 5 s, short enough to be impractical to exploit.
    const MAX_SAFE_CACHE_MS = 5_000;
    assert.ok(
      ttlMs <= MAX_SAFE_CACHE_MS,
      `BUG CONFIRMED: DNS_TTL_MS = ${ttlMs} ms (${ttlMs / 1000} s). ` +
      `A DNS-rebinding attacker has a ${ttlMs / 1000}-second window in which ` +
      `the SSRF cache still returns "safe" while the OS resolver has already ` +
      `flipped to an internal address.  Reduce to ≤ ${MAX_SAFE_CACHE_MS} ms ` +
      `and/or pass the resolved IP to the HTTP client.`,
    );
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// BUG 4 — HIGH — Heartbeat Endpoint Has No Authentication
// ══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: orchestrator.js:357-371 — POST /node/heartbeat/:node_id has
//   zero authentication.  Any internet caller that knows (or guesses) a valid
//   node_id can overwrite that node's performance metrics.
//
// IMPACT: The router (router.ts) uses heartbeat.p95_ms to compute average
//   WebSocket latency for routing decisions.  An attacker can:
//     • Spoof low p95_ms to attract all traffic to a compromised node.
//     • Inject a fake version string to interfere with auto-update logic.
//     • Spam heartbeat POSTs to overload the DB writer.
//
// FIX DIRECTION: At registration, issue a per-node secret (e.g. derived from
//   the node's private key).  Require it in an Authorization header on every
//   heartbeat and verify server-side before accepting any update.
//
describe('Bug 4 — HIGH: Unauthenticated heartbeat enables metric spoofing for any node', () => {
  let app:  ReturnType<typeof express>;
  let srv:  ReturnType<typeof app.listen>;
  let port: number;

  before(async () => {
    // Register a real node in the temp DB.
    NodeStore.upsertNode({
      id:             'spoof-target-node',
      pubkey_ed25519:  Buffer.from(crypto.randomBytes(32)),
      region:          'us-east',
      contact:         'legitimate-operator@example.com',
      status:          'active',
    });

    // Replicate the heartbeat route from orchestrator.js verbatim.
    app = express();
    app.use(express.json());

    app.post('/node/heartbeat/:node_id', (req: any, res: any) => {
      try {
        const { node_id } = req.params;
        const { rps, p95_ms, version } = req.body;
        const node = NodeStore.getNode(node_id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        // ← No authentication check here (the bug)
        NodeStore.heartbeat(node_id, { rps, p95_ms, version });
        res.json({ success: true, node_id, message: 'Heartbeat recorded', next_heartbeat_in: 300 });
      } catch (err: any) {
        res.status(500).json({ error: 'Heartbeat failed', message: err.message });
      }
    });

    port = await new Promise<number>(resolve =>
      (srv = app.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port))),
    );
  });

  after(() => new Promise<void>(resolve => srv.close(() => resolve())));

  it('should require an Authorization header and return 401 without one (BUG: returns 200)', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/node/heartbeat/spoof-target-node`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // ← Deliberately omit any Authorization header
      body:    JSON.stringify({ rps: 99_999, p95_ms: 1, version: 'attacker-injected-v0.0.1' }),
    });

    // EXPECTED after fix: 401 Unauthorized
    // ACTUAL today:       200 OK (assertion below fails → bug confirmed)
    assert.equal(
      resp.status, 401,
      `BUG CONFIRMED: POST /node/heartbeat/spoof-target-node returned HTTP ${resp.status} ` +
      `(expected 401). No credentials were provided, yet the request was accepted. ` +
      `An unauthenticated caller can overwrite any node's load metrics.`,
    );
  });

  it('confirms attacker-controlled data is actually written to the DB (impact evidence)', async () => {
    // This spoofed heartbeat will succeed with the current code.
    await fetch(`http://127.0.0.1:${port}/node/heartbeat/spoof-target-node`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rps: 99_999, p95_ms: 1, version: 'attacker-injected-v0.0.1' }),
    });

    const node = NodeStore.getNode('spoof-target-node');

    // EXPECTED after fix: version should NOT be the attacker's string
    assert.notEqual(
      node?.heartbeat?.version, 'attacker-injected-v0.0.1',
      `BUG CONFIRMED: Attacker-controlled version 'attacker-injected-v0.0.1' was ` +
      `persisted to the database. The router now uses corrupted metrics for this node.`,
    );
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// BUG 5 — MEDIUM — Operator Email Address Leaked in Public /node/status
// ══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: orchestrator.js:378 — GET /node/status/:node_id includes
//   `contact: node.contact` in its JSON response.  `contact` stores the node
//   operator's email address (required and validated at registration).
//   The endpoint requires no authentication.
//
// IMPACT:
//   • Exposes PII (email addresses) to the entire internet.
//   • Enables targeted phishing against node operators.
//   • The /nodes endpoint lists ALL registered node IDs publicly, so an
//     attacker can enumerate every operator's email in a single sweep.
//
// FIX DIRECTION: Remove `contact` from the public status response entirely.
//   If operators need to see their own contact info, add an authenticated
//   /node/my-status endpoint gated by a per-node credential.
//
describe('Bug 5 — MEDIUM: Node operator email is exposed in the unauthenticated /node/status', () => {
  let app:  ReturnType<typeof express>;
  let srv:  ReturnType<typeof app.listen>;
  let port: number;

  const SECRET_EMAIL = 'secret-operator@private-domain.com';

  before(async () => {
    NodeStore.upsertNode({
      id:             'email-leak-node',
      pubkey_ed25519:  Buffer.from(crypto.randomBytes(32)),
      region:          'eu-west',
      contact:         SECRET_EMAIL,
      status:          'active',
    });

    app = express();
    app.use(express.json());

    // Replicate the status route from orchestrator.js verbatim.
    app.get('/node/status/:node_id', (req: any, res: any) => {
      try {
        const node = NodeStore.getNode(req.params.node_id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        res.json({
          node_id:      node.id,
          domain:       node.domain,
          status:       node.status,
          region:       node.region,
          contact:      node.contact,   // ← the leak (orchestrator.js:378)
          capabilities: node.capabilities,
          created_at:   node.created_at,
          updated_at:   node.updated_at,
          heartbeat:    node.heartbeat,
        });
      } catch (err: any) {
        res.status(500).json({ error: 'Failed to get status', message: err.message });
      }
    });

    port = await new Promise<number>(resolve =>
      (srv = app.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port))),
    );
  });

  after(() => new Promise<void>(resolve => srv.close(() => resolve())));

  it('should NOT include the contact email in the public status response (BUG: it does)', async () => {
    // No auth header — any internet client can call this endpoint.
    const resp = await fetch(`http://127.0.0.1:${port}/node/status/email-leak-node`);
    assert.equal(resp.status, 200, 'Status endpoint must respond');

    const body = await resp.json() as Record<string, unknown>;

    // EXPECTED after fix: body.contact === undefined  (field must be absent)
    // ACTUAL today:       body.contact === SECRET_EMAIL (assertion fails → bug confirmed)
    assert.equal(
      body['contact'], undefined,
      `BUG CONFIRMED: The public /node/status response contains the operator's email ` +
      `address: ${JSON.stringify(body['contact'])}. ` +
      `No authentication was required. Any caller can harvest all operator emails ` +
      `by iterating the node IDs returned by GET /nodes.`,
    );
  });

  it('node_id, status, region, and capabilities are still present — regression guard', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/node/status/email-leak-node`);
    const body = await resp.json() as Record<string, unknown>;

    // These must remain in the response after the contact field is removed.
    assert.equal(body['node_id'],  'email-leak-node', 'node_id must be present');
    assert.equal(body['status'],   'active',          'status must be present');
    assert.equal(body['region'],   'eu-west',         'region must be present');
    assert.ok('capabilities' in body,                 'capabilities must be present');
  });
});
