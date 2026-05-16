# Consensus — Security Bug Hunt Handoff

**Branch:** `claude/vibrant-albattani-M0tL8`
**PR:** https://github.com/Demali-876/consensus/pull/10
**Date:** 2026-05-16

---

## What Was Done

A daily security and performance audit was run against the server. Five bugs were found, documented, and confirmed with failing tests. All tests live in:

```
server/utils/tests/security-perf-bugs.test.ts
```

Each test is written to **fail with the current code** — a fully green run means all five bugs are fixed.

Fix snippets were proposed for all five bugs. Bugs 1–3 and 5 are waiting for the developer to evaluate and insert. Bug 4 was iterated on (see below).

---

## Bug Status

### Bug 1 — HIGH — Uncapped `x-cache-ttl` (cache poisoning)
**File:** `server/features/proxy/proxy.ts:242–248`

**Root cause:** The `x-cache-ttl` header from the caller is accepted without any upper bound. A caller can send `x-cache-ttl: 9999999999` (~317 years) and permanently poison any cache entry.

**Current code:**
```ts
const resolvedTTL = cacheTTL !== undefined ? cacheTTL
                  : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
                  : 300;
const ttl = resolvedTTL === 0 ? 1 : Math.max(1, resolvedTTL);  // no upper bound
```

**Proposed fix — clamp after the existing resolution logic:**
```ts
const MAX_TTL     = 86_400; // 1 day
const resolvedTTL = cacheTTL !== undefined ? cacheTTL
                  : Number.isInteger(ttlFromHdr) && ttlFromHdr >= 0 ? ttlFromHdr
                  : 300;
const ttl = resolvedTTL === 0 ? 0 : Math.min(Math.max(1, resolvedTTL), MAX_TTL);
```

**Status:** Proposed — not yet inserted.

---

### Bug 2 — MEDIUM — `x-cache-ttl: 0` cannot express "do not cache"
**File:** `server/features/proxy/proxy.ts:248`

**Root cause:** `resolvedTTL === 0` is remapped to `1` to avoid passing `0` to `node-cache` (which treats `0` as "never expire"). The side effect is that callers have no way to request a live, uncached response.

**Note:** This is the same line as Bug 1. Fix both together.

**Proposed fix — treat `0` as a skip-cache sentinel before any `cache.get` / `cache.set` call:**

In `proxy.ts`, after computing `resolvedTTL`, branch early:
```ts
const skipCache = resolvedTTL === 0;
const ttl       = skipCache ? undefined : Math.min(Math.max(1, resolvedTTL), MAX_TTL);

// later, before the cache lookup:
if (!skipCache) {
  const cached = this.cache.get<ProxyResponse>(dedupeKey);
  if (cached) { /* return cache hit */ }
}

// and after the upstream fetch:
if (!skipCache) {
  this.cache.set(dedupeKey, response, ttl);
}
```

**Status:** Proposed — not yet inserted.

---

### Bug 3 — HIGH — SSRF TOCTOU / DNS rebinding window
**File:** `server/utils/ssrf.ts`

**Root cause:** `isPrivateTarget()` resolves the hostname via `dns.lookup()`, caches the result for **30 seconds**, and returns a plain `boolean`. The proxy then passes the original hostname to `axios`, which re-resolves DNS independently via the OS. This creates a 30-second window where an attacker can flip a domain from a public IP to `127.0.0.1` after the SSRF check passes.

**Attack sequence:**
1. Attacker sets `evil.example` DNS TTL to 1 s, pointing to `1.2.3.4` (public).
2. `isPrivateTarget('http://evil.example/')` → resolves → `false` → cached 30 s.
3. Attacker flips DNS to `127.0.0.1`.
4. Within the 30 s window: SSRF cache still returns `false`; axios re-resolves and sends request to `127.0.0.1`.

**Proposed fix — return the resolved address so the proxy can pin it:**

Change `ssrf.ts` return type:
```ts
export type SsrfCheckResult = { isPrivate: boolean; resolvedAddress?: string };

export async function isPrivateTarget(urlString: string): Promise<SsrfCheckResult> {
  // ... existing logic ...
  // instead of: return isPrivate
  // return:
  return { isPrivate, resolvedAddress: firstPublicAddress };
}
```

Then in `proxy.ts`, replace the hostname with the resolved IP when constructing the axios request:
```ts
const ssrf = await isPrivateTarget(target_url);
if (ssrf.isPrivate) throw new TypeError('SSRF: target resolves to a private address');

// Pin the resolved IP so axios does not re-resolve
const pinnedUrl = ssrf.resolvedAddress
  ? target_url.replace(new URL(target_url).hostname, ssrf.resolvedAddress)
  : target_url;
const response = await axios({ url: pinnedUrl, ... });
```

Also reduce `DNS_TTL_MS` from `30_000` to `5_000` ms as a defence-in-depth measure (currently the 30 s window makes exploitation practical).

**Status:** Proposed — not yet inserted.

---

### Bug 4 — HIGH — Unauthenticated heartbeat endpoint
**File:** `server/features/nodes/orchestrator.js:357–371`

**Root cause:** `POST /node/heartbeat/:node_id` has no authentication. Any caller that knows a valid `node_id` (which are listed publicly by `GET /nodes`) can overwrite that node's `rps`, `p95_ms`, and `version` metrics. The router uses `p95_ms` for routing decisions.

**Two fixes were considered:**

**Option A — Ed25519 signature (original proposal, requires instance changes):**
Instance signs canonical JSON payload with its private key; server verifies against stored `pubkey_ed25519` DER blob.

**Option B — IP allowlist (accepted by developer, server-only change):**
The node's registered `ipv4`/`ipv6` are stored in `capabilities` at registration. Compare `req.socket.remoteAddress` against the stored IPs. No instance-side changes needed.

**Proposed fix (Option B) — replace the heartbeat handler:**
```js
app.post('/node/heartbeat/:node_id', (req, res) => {
  try {
    const { node_id } = req.params;
    const { rps, p95_ms, version } = req.body;

    const node = NodeStore.getNode(node_id);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const remote  = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const trusted = [node.capabilities?.ipv4, node.capabilities?.ipv6].filter(Boolean);
    if (!trusted.includes(remote)) {
      console.warn(`[Heartbeat] Rejected from ${remote} for node ${node_id}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    NodeStore.heartbeat(node_id, { rps, p95_ms, version });
    res.json({ success: true, node_id, message: 'Heartbeat recorded', next_heartbeat_in: 300 });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: 'Heartbeat failed', message: error.message });
  }
});
```

**Caveat:** `ipv4` in the DB is self-reported at registration (from request body, not `req.socket.remoteAddress`). If the server sits behind a reverse proxy, `req.socket.remoteAddress` at heartbeat time will be the proxy IP — in that case this check won't work and Option A (Ed25519 signing) is the safer path.

**Status:** Proposed — not yet inserted.

---

### Bug 5 — MEDIUM — Operator email leaked in public `/node/status`
**File:** `server/features/nodes/orchestrator.js:378`

**Root cause:** `GET /node/status/:node_id` returns `contact: node.contact` in its JSON response. `contact` holds the operator's email address (required at registration, verified via email token). The endpoint requires no authentication. Combined with `GET /nodes` listing all node IDs publicly, any caller can harvest every operator's email in one sweep.

**Proposed fix — remove `contact` from the response:**
```js
// orchestrator.js:373-393 — GET /node/status/:node_id
res.json({
  node_id:      node.id,
  domain:       node.domain,
  status:       node.status,
  region:       node.region,
  // contact:   node.contact,   ← remove this line
  capabilities: node.capabilities,
  created_at:   node.created_at,
  updated_at:   node.updated_at,
  heartbeat:    node.heartbeat,
});
```

**Status:** Proposed — not yet inserted.

---

## Running the Tests

```bash
cd server
node --import tsx/esm --test utils/tests/security-perf-bugs.test.ts
```

Expected result before fixes: **9 failing, 3 passing** (the 3 passing tests are regression guards that must stay green after fixes are applied).

Expected result after all fixes: **12 passing**.

---

## Pre-existing Test Failures (Unrelated)

`server/utils/tests/proxy.test.ts` has 33 of 62 tests failing. All failures use `http://localhost:19991` as the target, which the SSRF guard now correctly blocks. These tests predate the SSRF protection and need their test target updated to a non-loopback address — this is a separate task, not part of this bug hunt.
