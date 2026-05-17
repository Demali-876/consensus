import crypto from "crypto";
import type { Express, Request, Response } from "express";
import NodeStore from "./data/node_store.js";
import { log } from "./utils/log.ts";

interface NodeReleaseManifest {
  product: "consensus-node";
  version: string;
  platform: string;
  commit: string;
  routes_hash: string;
  tarball_sha256?: string;
  download_url?: string;
  signature?: string;
  signing_key_id?: string;
}

interface IntegrityPayload {
  product: "consensus-node";
  version: string;
  runtime: "bun";
  platform: string;
  node_public_key_pem: string;
  manifest: NodeReleaseManifest;
  timestamp: number;
  nonce: string;
  signature: string;
}

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

      const validation = validateIntegrityPayload(payload);
      if (validation) {
        log.warn("updater", "integrity-rejected", {
          node_id,
          reason: validation.error,
          missing: "missing" in validation ? validation.missing : undefined,
        });
        return res.status(400).json(validation);
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

      const nodeKey = crypto.createPublicKey({ key: node.pubkey_ed25519, format: "der", type: "spki" });
      const presentedKey = crypto.createPublicKey(payload.node_public_key_pem).export({ format: "der", type: "spki" });
      const registeredKey = nodeKey.export({ format: "der", type: "spki" });
      if (presentedKey.length !== registeredKey.length || !crypto.timingSafeEqual(Buffer.from(presentedKey), Buffer.from(registeredKey))) {
        log.warn("updater", "integrity-rejected", { node_id, reason: "public key mismatch" });
        return res.status(403).json({ error: "Integrity public key does not match registered node key" });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - payload.timestamp) > 300) {
        log.warn("updater", "integrity-rejected", {
          node_id,
          reason: "timestamp outside tolerance",
          timestamp: payload.timestamp,
          now: nowSec,
        });
        return res.status(400).json({ error: "Timestamp too old or in the future" });
      }

      const signaturePayload = canonicalJson({
        product: payload.product,
        version: payload.version,
        runtime: payload.runtime,
        platform: payload.platform,
        node_public_key_pem: payload.node_public_key_pem,
        manifest: payload.manifest,
        timestamp: payload.timestamp,
        nonce: payload.nonce,
      });

      const valid = crypto.verify(
        null,
        Buffer.from(signaturePayload, "utf8"),
        nodeKey,
        Buffer.from(payload.signature, "base64"),
      );
      if (!valid) {
        log.warn("updater", "integrity-rejected", { node_id, reason: "invalid signature" });
        return res.status(403).json({ error: "Invalid integrity signature" });
      }

      const required = NodeStore.getRequiredManifest();
      if (required && !manifestMatchesRequired(payload.manifest, required.manifest)) {
        NodeStore.clearNodeVerification(node_id);
        log.warn("updater", "integrity-mismatch", {
          node_id,
          observed_version: payload.manifest.version,
          observed_commit: payload.manifest.commit,
          required_version: required.manifest.version,
          required_commit: required.manifest.commit,
        });
        return res.json({
          verified: false,
          reason: "Node manifest does not match required manifest",
          required: required.manifest,
          observed: payload.manifest,
        });
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

  app.post("/admin/manifest", (req: Request, res: Response) => {
    try {
      if (!config.adminKey) {
        log.error("updater", "manifest-rejected", { reason: "admin key not configured" });
        return res.status(503).json({ error: "Admin key not configured" });
      }
      if (!isAdminKeyValid(req.headers["x-admin-key"], config.adminKey)) {
        log.warn("updater", "manifest-rejected", { reason: "invalid admin key" });
        return res.status(403).json({ error: "Invalid admin key" });
      }

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

function validateIntegrityPayload(payload: Partial<IntegrityPayload> | null | undefined) {
  const required = ["product", "version", "runtime", "platform", "node_public_key_pem", "manifest", "timestamp", "nonce", "signature"];
  if (!payload || typeof payload !== "object") return { error: "Integrity payload must be an object" };
  const missing = required.filter((key) => (payload as Record<string, unknown>)[key] == null);
  if (missing.length > 0) return { error: "Missing required fields", required, missing };
  if (payload.product !== "consensus-node") return { error: "Invalid product" };
  if (payload.runtime !== "bun") return { error: "Invalid runtime" };
  if (payload.manifest?.product !== "consensus-node") return { error: "Invalid manifest product" };
  return null;
}

function manifestMatchesRequired(observed: NodeReleaseManifest, required: NodeReleaseManifest): boolean {
  return observed.version === required.version &&
    observed.platform === required.platform &&
    observed.commit === required.commit &&
    observed.routes_hash === required.routes_hash &&
    (required.tarball_sha256 == null || observed.tarball_sha256 === required.tarball_sha256);
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) output[key] = sortValue(input[key]);
  return output;
}
