import crypto from "crypto";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import NodeStore from "./data/node_store.js";
import { log } from "./utils/log.ts";
import {
  verifyIntegrityPayload,
  validateIntegrityPayload,
  type IntegrityPayload,
  type NodeReleaseManifest,
} from "./utils/integrity.ts";

const ADMIN_LOCKOUT_THRESHOLD = 5;
const ADMIN_LOCKOUT_WINDOW_MS = 15 * 60_000;
const ADMIN_LOCKOUT_DURATION_MS = 15 * 60_000;
const ADMIN_SWEEP_INTERVAL_MS = 60_000;

interface AdminAttemptState {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
}

const adminAttempts = new Map<string, AdminAttemptState>();

const adminSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of adminAttempts) {
    if (state.lockedUntil < now && now - state.windowStartedAt > ADMIN_LOCKOUT_WINDOW_MS) {
      adminAttempts.delete(ip);
    }
  }
}, ADMIN_SWEEP_INTERVAL_MS);
adminSweepTimer.unref();

function adminLockedUntil(ip: string): number | null {
  const state = adminAttempts.get(ip);
  if (!state) return null;
  if (state.lockedUntil > Date.now()) return state.lockedUntil;
  return null;
}

function recordAdminFailure(ip: string): void {
  const now = Date.now();
  const state = adminAttempts.get(ip);
  if (!state || now - state.windowStartedAt > ADMIN_LOCKOUT_WINDOW_MS) {
    adminAttempts.set(ip, { failures: 1, windowStartedAt: now, lockedUntil: 0 });
    return;
  }
  state.failures += 1;
  if (state.failures >= ADMIN_LOCKOUT_THRESHOLD) {
    state.lockedUntil = now + ADMIN_LOCKOUT_DURATION_MS;
  }
}

function clearAdminFailures(ip: string): void {
  adminAttempts.delete(ip);
}

const adminLimiter = rateLimit({
  windowMs:        15 * 60_000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too Many Requests" },
});

interface UpdaterConfig {
  adminKey?: string;
}

export function registerUpdater(app: Express, config: UpdaterConfig = {}): void {
  log.info("updater", "registered", { admin_key_configured: Boolean(config.adminKey) });

  app.get("/update/latest", (_req: Request, res: Response) => {
    try {
      const required = NodeStore.getRequiredManifest();
      if (!required) {
        log.warn("updater", "latest-missing", {});
        return res.status(404).json({ error: "No required version set" });
      }
      log.info("updater", "latest-served", {
        version: required.version,
        required: required.required,
        manifest_version: required.manifest?.version,
        platform: required.manifest?.platform,
        commit: required.manifest?.commit,
      });
      res.json(required.manifest);
    } catch (error: any) {
      log.error("updater", "latest-failed", { message: error.message });
      res.status(500).json({ error: "Failed to get update info", message: error.message });
    }
  });

  app.post("/node/verify-integrity/:node_id", (req: Request, res: Response) => {
    try {
      const { node_id } = req.params;
      const payload = req.body as IntegrityPayload;

      const malformed = validateIntegrityPayload(payload);
      if (malformed) {
        log.warn("updater", "integrity-rejected", { node_id, reason: malformed.error, missing: malformed.missing });
        return res.status(400).json(malformed);
      }

      const node = NodeStore.getNode(node_id);
      if (!node) {
        log.warn("updater", "integrity-rejected", { node_id, reason: "node not found" });
        return res.status(404).json({ error: "Node not found" });
      }
      if (!node.pubkey_ed25519) {
        log.warn("updater", "integrity-rejected", { node_id, reason: "missing ed25519 key" });
        return res.status(400).json({ error: "Node has no Ed25519 key" });
      }

      log.info("updater", "integrity-received", {
        node_id,
        version: payload.manifest.version,
        platform: payload.manifest.platform,
        commit: payload.manifest.commit,
        routes_hash: payload.manifest.routes_hash,
        tarball_sha256: payload.manifest.tarball_sha256 ?? null,
      });

      // Verify against the REGISTERED node key (the trusted anchor post-join).
      // Same verifier the eval path uses — there it anchors to the
      // handshake-verified key instead.
      const trustedKey = crypto.createPublicKey({ key: node.pubkey_ed25519, format: "der", type: "spki" });
      const required = NodeStore.getRequiredManifest();
      const result = verifyIntegrityPayload(payload, trustedKey, required?.manifest ?? null);

      if (!result.ok) {
        if (result.kind === "manifest_mismatch") {
          NodeStore.clearNodeVerification(node_id);
          log.warn("updater", "integrity-mismatch", {
            node_id,
            observed_version: result.observed.version,
            observed_commit: result.observed.commit,
            required_version: result.required.version,
            required_commit: result.required.commit,
          });
          return res.json({
            verified: false,
            reason: "Node manifest does not match required manifest",
            required: result.required,
            observed: result.observed,
          });
        }
        log.warn("updater", "integrity-rejected", { node_id, reason: result.reason });
        return res.status(result.status).json({ error: result.reason });
      }

      NodeStore.updateNodeVerification(
        node_id,
        true,
        payload.manifest.version,
        payload.manifest.tarball_sha256 ?? payload.manifest.routes_hash,
      );

      log.info("updater", "integrity-verified", {
        node_id,
        version: payload.manifest.version,
        platform: payload.manifest.platform,
        commit: payload.manifest.commit,
        routes_hash: payload.manifest.routes_hash,
      });
      res.json({
        verified: true,
        node_id,
        version: payload.manifest.version,
        platform: payload.manifest.platform,
        commit: payload.manifest.commit,
        routes_hash: payload.manifest.routes_hash,
      });
    } catch (error: any) {
      log.error("updater", "integrity-failed", { message: error.message });
      res.status(500).json({ error: "Integrity verification failed", message: error.message });
    }
  });

  app.post("/admin/manifest", adminLimiter, (req: Request, res: Response) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    try {
      if (!config.adminKey) {
        log.error("updater", "manifest-rejected", { reason: "admin key not configured" });
        return res.status(503).json({ error: "Admin key not configured" });
      }

      const lockedUntil = adminLockedUntil(ip);
      if (lockedUntil != null) {
        const retryAfterSec = Math.ceil((lockedUntil - Date.now()) / 1000);
        log.warn("updater", "manifest-rejected", { reason: "locked out", ip, retry_after_s: retryAfterSec });
        res.set("Retry-After", String(retryAfterSec));
        return res.status(429).json({ error: "Too many invalid admin key attempts. Try again later." });
      }

      if (!isAdminKeyValid(req.headers["x-admin-key"], config.adminKey)) {
        recordAdminFailure(ip);
        log.warn("updater", "manifest-rejected", { reason: "invalid admin key", ip });
        return res.status(403).json({ error: "Invalid admin key" });
      }
      clearAdminFailures(ip);

      const { manifest, required } = req.body as { manifest?: NodeReleaseManifest; required?: boolean };
      if (!manifest?.version) {
        log.warn("updater", "manifest-rejected", { reason: "manifest.version is required" });
        return res.status(400).json({ error: "manifest.version is required" });
      }

      NodeStore.upsertManifest(
        manifest.version,
        manifest,
        null,
        required !== false,
      );

      log.info("updater", "manifest-stored", {
        version: manifest.version,
        platform: manifest.platform,
        commit: manifest.commit,
        routes_hash: manifest.routes_hash,
        tarball_sha256: manifest.tarball_sha256 ?? null,
        required: required !== false,
      });
      res.json({
        success: true,
        version: manifest.version,
        required: required !== false,
      });
    } catch (error: any) {
      log.error("updater", "manifest-failed", { message: error.message });
      res.status(500).json({ error: "Failed to store manifest", message: error.message });
    }
  });
}

/**
 * Constant-time comparison for the admin key.  The naive `presented === expected`
 * short-circuits at the first differing byte and leaks character positions via
 * response timing, allowing byte-by-byte recovery of the key over many requests.
 *
 * crypto.timingSafeEqual requires equal-length inputs; we normalise both values
 * to the longer of the two so timing does not vary with the presented length.
 * A separate length check then enforces the actual length match.
 */
function isAdminKeyValid(presentedHeader: unknown, expected: string): boolean {
  const presented = typeof presentedHeader === "string" ? presentedHeader : "";
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf  = Buffer.from(expected,  "utf8");
  const padLen       = Math.max(presentedBuf.length, expectedBuf.length);
  const padPresented = Buffer.alloc(padLen);
  const padExpected  = Buffer.alloc(padLen);
  presentedBuf.copy(padPresented);
  expectedBuf.copy(padExpected);
  const equal = crypto.timingSafeEqual(padPresented, padExpected);
  return presentedBuf.length === expectedBuf.length && equal;
}
