import crypto from "crypto";
import type { Express, Request, Response } from "express";
import NodeStore from "./data/node_store.js";

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
  app.get("/update/latest", (_req: Request, res: Response) => {
    try {
      const required = NodeStore.getRequiredManifest();
      if (!required) return res.status(404).json({ error: "No required version set" });
      res.json(required.manifest);
    } catch (error: any) {
      console.error("Get latest update error:", error);
      res.status(500).json({ error: "Failed to get update info", message: error.message });
    }
  });

  app.post("/node/verify-integrity/:node_id", (req: Request, res: Response) => {
    try {
      const { node_id } = req.params;
      const payload = req.body as IntegrityPayload;

      const validation = validateIntegrityPayload(payload);
      if (validation) return res.status(400).json(validation);

      const node = NodeStore.getNode(node_id);
      if (!node) return res.status(404).json({ error: "Node not found" });
      if (!node.pubkey_ed25519) return res.status(400).json({ error: "Node has no Ed25519 key" });

      const nodeKey = crypto.createPublicKey({ key: node.pubkey_ed25519, format: "der", type: "spki" });
      const presentedKey = crypto.createPublicKey(payload.node_public_key_pem).export({ format: "der", type: "spki" });
      const registeredKey = nodeKey.export({ format: "der", type: "spki" });
      if (presentedKey.length !== registeredKey.length || !crypto.timingSafeEqual(Buffer.from(presentedKey), Buffer.from(registeredKey))) {
        return res.status(403).json({ error: "Integrity public key does not match registered node key" });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - payload.timestamp) > 300) {
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
      if (!valid) return res.status(403).json({ error: "Invalid integrity signature" });

      const required = NodeStore.getRequiredManifest();
      if (required && !manifestMatchesRequired(payload.manifest, required.manifest)) {
        NodeStore.clearNodeVerification(node_id);
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

      res.json({
        verified: true,
        node_id,
        version: payload.manifest.version,
        platform: payload.manifest.platform,
        commit: payload.manifest.commit,
        routes_hash: payload.manifest.routes_hash,
      });
    } catch (error: any) {
      console.error("Verify integrity error:", error);
      res.status(500).json({ error: "Integrity verification failed", message: error.message });
    }
  });

  app.post("/admin/manifest", (req: Request, res: Response) => {
    try {
      if (!config.adminKey) return res.status(503).json({ error: "Admin key not configured" });
      if (req.headers["x-admin-key"] !== config.adminKey) return res.status(403).json({ error: "Invalid admin key" });

      const { manifest, required } = req.body as { manifest?: NodeReleaseManifest; required?: boolean };
      if (!manifest?.version) return res.status(400).json({ error: "manifest.version is required" });

      NodeStore.upsertManifest(
        manifest.version,
        manifest,
        null,
        required !== false,
      );

      res.json({
        success: true,
        version: manifest.version,
        required: required !== false,
      });
    } catch (error: any) {
      console.error("Admin manifest error:", error);
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
