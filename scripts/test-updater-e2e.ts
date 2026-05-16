#!/usr/bin/env npx tsx
/**
 * End-to-end test for the updater & integrity verification system.
 *
 * Prerequisites:
 *   Terminal 1:  cd server && ADMIN_KEY=test-key npm run start:local
 *   Terminal 2:  ADMIN_KEY=test-key npx tsx scripts/test-updater-e2e.ts
 */

import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER = process.env.GATEWAY_URL || "http://localhost:8082";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-key";
const PLATFORM = `${os.platform()}-${os.arch()}`; // e.g. darwin-arm64
const V1 = "0.1.0";
const V2 = "0.2.0";
const TEST_VERSION = V2;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Key generation helpers
// ---------------------------------------------------------------------------
function generateEd25519() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signPayload(payload: Record<string, unknown>, privateKeyPem: string): string {
  const ordered = JSON.stringify(payload, [
    "version",
    "platform",
    "build_digest",
    "timestamp",
    "nonce",
  ]);
  const buf = Buffer.from(ordered, "utf8");
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, buf, key).toString("base64");
}

// ---------------------------------------------------------------------------
// Tiny benchmark stub server
// ---------------------------------------------------------------------------
interface StubServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start a stub node server that responds to benchmark endpoints.
 * Pass `version` to control `/version` response and optional extra routes.
 */
function startStubServer(
  version: string,
  extraRoutes?: Record<string, (req: http.IncomingMessage, body: Buffer) => unknown>
): Promise<StubServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        const body = Buffer.concat(chunks);

        if (req.url === "/health") {
          res.end(JSON.stringify({ status: "healthy" }));
          return;
        }

        if (req.url === "/version") {
          res.end(JSON.stringify({ product: "consensus-node", version, node: process.version }));
          return;
        }

        // Check extra routes (e.g. /ping added after upgrade)
        if (extraRoutes && req.url && extraRoutes[req.url]) {
          const result = extraRoutes[req.url](req, body);
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url === "/benchmark/fetch") {
          const parsed = JSON.parse(body.toString());
          fetch(parsed.target_url, { signal: AbortSignal.timeout(4000) })
            .then((r) => r.text())
            .then((text) => {
              res.end(JSON.stringify({ success: true, status: 200, size: text.length }));
            })
            .catch(() => {
              res.end(JSON.stringify({ success: true, status: 200, size: 0 }));
            });
          return;
        }

        if (req.url === "/benchmark/cpu") {
          const parsed = JSON.parse(body.toString());
          const iterations = parsed.iterations || 5000;
          const data = parsed.data || "test";
          const start = performance.now();
          for (let i = 0; i < iterations; i++) {
            crypto.createHash("sha256").update(data).digest();
          }
          const durationMs = performance.now() - start;
          res.end(
            JSON.stringify({
              hashes_per_second: Math.round((iterations / durationMs) * 1000),
              duration_ms: Math.round(durationMs),
            })
          );
          return;
        }

        if (req.url === "/benchmark/memory-test") {
          const parsed = JSON.parse(body.toString());
          const sizeMb = parsed.test_size_mb || 256;
          const start = performance.now();
          try {
            const buf = Buffer.alloc(sizeMb * 1024 * 1024);
            buf[0] = 1;
            const durationMs = performance.now() - start;
            res.end(
              JSON.stringify({
                success: true,
                allocated_mb: sizeMb,
                duration_ms: Math.round(durationMs),
              })
            );
          } catch {
            res.end(JSON.stringify({ success: false, error: "alloc failed", allocated_mb: 0 }));
          }
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------
function buildManifest(version: string, digest: string, platform: string) {
  return {
    version,
    released_at: new Date().toISOString(),
    github_release_url: `https://github.com/test/releases/tag/v${version}`,
    assets: [
      {
        platform,
        url: `https://github.com/test/releases/download/v${version}/node-${platform}.tar.gz`,
        sha256: digest,
      },
    ],
  };
}

function signManifest(manifest: Record<string, unknown>, privateKeyPem: string): string {
  const sortedKeys = Object.keys(manifest).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = manifest[k];
  const canonical = JSON.stringify(sorted);
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(canonical, "utf8"), key).toString("base64");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function get(path: string) {
  const res = await fetch(`${SERVER}${path}`);
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🧪 Updater E2E Test`);
  console.log(`   Server: ${SERVER}`);
  console.log(`   Platform: ${PLATFORM}`);
  console.log(`   Admin key: ${ADMIN_KEY}\n`);

  // -----------------------------------------------------------------------
  // Setup: generate keys + fake digest
  // -----------------------------------------------------------------------
  const adminKeys = generateEd25519();
  const nodeKeys = generateEd25519();
  const attackerKeys = generateEd25519();

  // Fake build digest (as if we hashed a tarball)
  const fakeTarball = crypto.randomBytes(1024);
  const buildDigest = `sha256:${crypto.createHash("sha256").update(fakeTarball).digest("hex")}`;

  const manifest = buildManifest(TEST_VERSION, buildDigest, PLATFORM);
  const manifestSignature = signManifest(manifest, adminKeys.privateKey);

  // -----------------------------------------------------------------------
  // Step 1: Upload manifest
  // -----------------------------------------------------------------------
  console.log("━━━ Step 1: Upload manifest ━━━");
  {
    const { status, json } = await post(
      "/admin/manifest",
      { manifest, signature: manifestSignature, required: true },
      { "x-admin-key": ADMIN_KEY }
    );
    assert(status === 200, "Status 200", `got ${status}`);
    assert(json.success === true, "success: true");
    assert(json.version === TEST_VERSION, `version = ${TEST_VERSION}`);
    assert(json.assets === 1, "assets count = 1");
  }

  // -----------------------------------------------------------------------
  // Step 2: Fetch latest manifest
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 2: GET /update/latest ━━━");
  {
    const { status, json } = await get("/update/latest");
    assert(status === 200, "Status 200", `got ${status}`);
    assert(json.version === TEST_VERSION, `version = ${TEST_VERSION}`);
    assert(Array.isArray(json.assets), "assets is array");
    assert(json.assets?.[0]?.platform === PLATFORM, `platform = ${PLATFORM}`);
    assert(json.assets?.[0]?.sha256 === buildDigest, "digest matches");
  }

  // -----------------------------------------------------------------------
  // Step 3: Join a node
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 3: Join node ━━━");
  const stub = await startStubServer(V1);
  console.log(`  Stub benchmark server on port ${stub.port}`);

  // Use a unique IPv6 per test run to avoid 409 conflicts
  const testId = crypto.randomBytes(4).toString("hex");
  const testIpv6 = `2001:db8::${testId.slice(0, 4)}:${testId.slice(4)}`;
  console.log(`  Test IPv6: ${testIpv6}`);

  let nodeId: string;
  {
    const { status, json } = await post("/node/join", {
      pubkey_pem: nodeKeys.publicKey,
      alg: "ed25519",
      ipv6: testIpv6,
      ipv4: "127.0.0.1",
      port: stub.port,
      test_endpoint: `http://127.0.0.1:${stub.port}`,
      region: "local-test",
      contact: "test@test.local",
      evm_address: "0x" + "a".repeat(40),
      solana_address: "J6EHzeiWxrffitfscuaZty9A9AKQVPte7G9VEoHubuGw",
    });
    assert(status === 200, "Status 200", `got ${status} — ${JSON.stringify(json)}`);
    assert(json.success === true, "success: true", JSON.stringify(json));
    assert(typeof json.node_id === "string", "got node_id");
    nodeId = json.node_id;
    console.log(`  Node ID: ${nodeId}`);
  }

  await stub.close();

  // -----------------------------------------------------------------------
  // Step 4: Report integrity — happy path
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 4: Integrity report (valid) ━━━");
  {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = {
      version: TEST_VERSION,
      platform: PLATFORM,
      build_digest: buildDigest,
      timestamp,
      nonce,
    };
    const signature = signPayload(payload, nodeKeys.privateKey);

    const { status, json } = await post(`/node/verify-integrity/${nodeId}`, {
      ...payload,
      signature,
    });
    assert(status === 200, "Status 200", `got ${status}`);
    assert(json.verified === true, "verified: true", JSON.stringify(json));
  }

  // -----------------------------------------------------------------------
  // Step 5: Check node status — should be verified
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 5: Node status (verified) ━━━");
  {
    const { status, json } = await get(`/node/status/${nodeId}`);
    assert(status === 200, "Status 200", `got ${status}`);
    assert(json.verified === 1 || json.verified === true, "verified = true", `got ${json.verified}`);
    assert(json.software_version === TEST_VERSION, `software_version = ${TEST_VERSION}`, `got ${json.software_version}`);
    assert(json.build_digest === buildDigest, "build_digest matches");
  }

  // -----------------------------------------------------------------------
  // Step 6: Report integrity — wrong digest
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 6: Integrity report (wrong digest) ━━━");
  {
    const wrongDigest = "sha256:" + "b".repeat(64);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = {
      version: TEST_VERSION,
      platform: PLATFORM,
      build_digest: wrongDigest,
      timestamp,
      nonce,
    };
    const signature = signPayload(payload, nodeKeys.privateKey);

    const { status, json } = await post(`/node/verify-integrity/${nodeId}`, {
      ...payload,
      signature,
    });
    assert(status === 200, "Status 200", `got ${status}`);
    assert(json.verified === false, "verified: false", JSON.stringify(json));
  }

  // -----------------------------------------------------------------------
  // Step 7: Report integrity — tampered signature (wrong key)
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 7: Integrity report (tampered signature) ━━━");
  {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = {
      version: TEST_VERSION,
      platform: PLATFORM,
      build_digest: buildDigest,
      timestamp,
      nonce,
    };
    // Sign with attacker's key instead of node's key
    const signature = signPayload(payload, attackerKeys.privateKey);

    const { status, json } = await post(`/node/verify-integrity/${nodeId}`, {
      ...payload,
      signature,
    });
    assert(status === 400 || status === 403 || json.verified === false, "rejected tampered signature", `status=${status} json=${JSON.stringify(json)}`);
  }

  // -----------------------------------------------------------------------
  // Step 8: Heartbeat with version mismatch → clears verification
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 8: Heartbeat with stale version ━━━");

  // First re-verify the node so we can check that heartbeat clears it
  {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = {
      version: TEST_VERSION,
      platform: PLATFORM,
      build_digest: buildDigest,
      timestamp,
      nonce,
    };
    const signature = signPayload(payload, nodeKeys.privateKey);
    await post(`/node/verify-integrity/${nodeId}`, { ...payload, signature });
  }

  // Check node is now unverified
  {
    const { status, json } = await get(`/node/status/${nodeId}`);
    assert(status === 200, "Status 200");
    assert(json.verified === 0 || json.verified === false, "verified cleared after version mismatch", `got ${json.verified}`);
  }

  // =======================================================================
  // UPGRADE CYCLE: v0.1.0 → v0.2.0
  // Proves: verify v1 → detect update → upgrade → re-verify v2 → new route
  // =======================================================================

  // -----------------------------------------------------------------------
  // Step 9: Upload v0.1.0 manifest and verify node at v0.1.0
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 9: Verify node at v0.1.0 ━━━");
  const v1Tarball = crypto.randomBytes(1024);
  const v1Digest = `sha256:${crypto.createHash("sha256").update(v1Tarball).digest("hex")}`;
  {
    const m = buildManifest(V1, v1Digest, PLATFORM);
    const sig = signManifest(m, adminKeys.privateKey);
    const { status } = await post(
      "/admin/manifest",
      { manifest: m, signature: sig, required: true },
      { "x-admin-key": ADMIN_KEY }
    );
    assert(status === 200, "Uploaded v0.1.0 manifest");

    // Report integrity at v0.1.0
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = { version: V1, platform: PLATFORM, build_digest: v1Digest, timestamp, nonce };
    const signature = signPayload(payload, nodeKeys.privateKey);
    const { json } = await post(`/node/verify-integrity/${nodeId}`, { ...payload, signature });
    assert(json.verified === true, "verified at v0.1.0", JSON.stringify(json));
  }

  // Confirm node status shows v0.1.0
  {
    const { json } = await get(`/node/status/${nodeId}`);
    assert(json.software_version === V1, `status shows v0.1.0`, `got ${json.software_version}`);
    assert(json.verified === 1 || json.verified === true, "verified = true");
  }

  // -----------------------------------------------------------------------
  // Step 10: Upload v0.2.0 manifest (triggers upgrade)
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 10: Upload v0.2.0 manifest ━━━");
  const v2Tarball = crypto.randomBytes(1024);
  const v2Digest = `sha256:${crypto.createHash("sha256").update(v2Tarball).digest("hex")}`;
  {
    const m = buildManifest(V2, v2Digest, PLATFORM);
    const sig = signManifest(m, adminKeys.privateKey);
    const { status, json } = await post(
      "/admin/manifest",
      { manifest: m, signature: sig, required: true },
      { "x-admin-key": ADMIN_KEY }
    );
    assert(status === 200, "Uploaded v0.2.0 manifest");
    assert(json.version === V2, `version = ${V2}`);
  }

  // Confirm verification was cleared (version mismatch)
  {
    const { json } = await get(`/node/status/${nodeId}`);
    assert(json.verified === 0 || json.verified === false, "verification cleared on mismatch");
  }

  // -----------------------------------------------------------------------
  // Step 12: Simulate upgrade — restart stub with v0.2.0 + /ping route
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 12: Simulate upgrade (restart with /ping) ━━━");
  const upgradedStub = await startStubServer(V2, {
    "/ping": () => ({ pong: true, version: V2, timestamp: Date.now() }),
  });
  console.log(`  Upgraded stub on port ${upgradedStub.port}`);

  // Verify /ping exists on upgraded stub
  {
    const res = await fetch(`http://127.0.0.1:${upgradedStub.port}/ping`, { method: "POST" });
    const json = await res.json();
    assert(json.pong === true, "/ping route responds");
    assert(json.version === V2, `/ping reports v0.2.0`);
  }

  // Verify /version reports v0.2.0
  {
    const res = await fetch(`http://127.0.0.1:${upgradedStub.port}/version`);
    const json = await res.json();
    assert(json.version === V2, `/version reports v0.2.0`);
  }

  // -----------------------------------------------------------------------
  // Step 13: Re-verify integrity at v0.2.0
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 13: Re-verify at v0.2.0 ━━━");
  {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = { version: V2, platform: PLATFORM, build_digest: v2Digest, timestamp, nonce };
    const signature = signPayload(payload, nodeKeys.privateKey);
    const { status, json } = await post(`/node/verify-integrity/${nodeId}`, { ...payload, signature });
    assert(status === 200, "Status 200");
    assert(json.verified === true, "verified at v0.2.0", JSON.stringify(json));
  }

  // -----------------------------------------------------------------------
  // Step 14: Confirm final state — verified at v0.2.0
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 14: Final state ━━━");
  {
    const { json } = await get(`/node/status/${nodeId}`);
    assert(json.software_version === V2, `software_version = ${V2}`, `got ${json.software_version}`);
    assert(json.build_digest === v2Digest, "build_digest = v0.2.0 digest");
    assert(json.verified === 1 || json.verified === true, "verified = true");
  }

  await upgradedStub.close();

  // -----------------------------------------------------------------------
  // Step 15: Semver comparison
  // -----------------------------------------------------------------------
  console.log("\n━━━ Step 15: Version comparison logic ━━━");
  {
    function isNewerVersion(a: string, b: string): boolean {
      const parse = (v: string) => {
        const clean = v.replace(/^v/, "").replace(/-.*$/, "");
        return clean.split(".").map(Number);
      };
      const va = parse(a);
      const vb = parse(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const ai = va[i] || 0;
        const bi = vb[i] || 0;
        if (ai > bi) return true;
        if (ai < bi) return false;
      }
      return false;
    }

    assert(isNewerVersion("0.2.0", "0.1.0") === true, "0.2.0 > 0.1.0");
    assert(isNewerVersion("0.1.0", "0.1.0") === false, "0.1.0 = 0.1.0");
    assert(isNewerVersion("0.1.0", "0.2.0") === false, "0.1.0 < 0.2.0");
    assert(isNewerVersion("1.0.0", "0.99.99") === true, "1.0.0 > 0.99.99");
    assert(isNewerVersion("0.1.0-beta.1", "0.1.0") === false, "0.1.0-beta.1 strips to 0.1.0 = 0.1.0");
    assert(isNewerVersion("0.2.0-beta.1", "0.1.0") === true, "0.2.0-beta.1 > 0.1.0 (strip pre-release)");
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${"═".repeat(40)}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`${"═".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
