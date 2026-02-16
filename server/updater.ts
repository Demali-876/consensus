import crypto from "crypto";
import type { Express, Request, Response } from "express";
import NodeStore from "./data/node_store.js";

interface ManifestAsset {
  platform: string;
  url: string;
  sha256: string;
}

interface Manifest {
  version: string;
  released_at: string;
  github_release_url: string;
  assets: ManifestAsset[];
  signature?: string;
}

interface UpdaterConfig {
  adminKey?: string;
}

/**
 * Register updater endpoints on the Express app.
 */
export function registerUpdater(app: Express, config: UpdaterConfig): void {
  const { adminKey } = config;

  /**
   * GET /update/latest
   * Returns the currently required version manifest (no auth).
   */
  app.get("/update/latest", (req: Request, res: Response) => {
    try {
      const required = NodeStore.getRequiredManifest();

      if (!required) {
        return res.status(404).json({ error: "No required version set" });
      }

      res.json(required.manifest);
    } catch (error: any) {
      console.error("Get latest update error:", error);
      res.status(500).json({ error: "Failed to get update info", message: error.message });
    }
  });

  /**
   * POST /node/verify-integrity/:node_id
   * Node submits its version, platform, and build_digest signed with its Ed25519 key.
   * Server verifies signature, checks digest against manifest, marks node verified/unverified.
   */
  app.post("/node/verify-integrity/:node_id", (req: Request, res: Response) => {
    try {
      const { node_id } = req.params;
      const { version, platform, build_digest, timestamp, nonce, signature } = req.body;

      if (!version || !platform || !build_digest || !timestamp || !nonce || !signature) {
        return res.status(400).json({
          error: "Missing required fields",
          required: ["version", "platform", "build_digest", "timestamp", "nonce", "signature"],
        });
      }

      const node = NodeStore.getNode(node_id);
      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }

      // Verify Ed25519 signature
      const payload = JSON.stringify(
        { version, platform, build_digest, timestamp, nonce },
        ["version", "platform", "build_digest", "timestamp", "nonce"]
      );
      const payloadBuffer = Buffer.from(payload, "utf8");
      const signatureBuffer = Buffer.from(signature, "base64");

      let pubkey: crypto.KeyObject;
      try {
        pubkey = crypto.createPublicKey({
          key: node.pubkey,
          format: "der",
          type: "spki",
        });
      } catch (keyError: any) {
        return res.status(400).json({ error: "Invalid node public key", message: keyError.message });
      }

      const valid = crypto.verify(null, payloadBuffer, pubkey, signatureBuffer);
      if (!valid) {
        return res.status(403).json({ error: "Invalid signature" });
      }

      // Replay protection: reject timestamps older than 5 minutes
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - timestamp) > 300) {
        return res.status(400).json({ error: "Timestamp too old or in the future" });
      }

      // Load manifest for the submitted version
      const manifestEntry = NodeStore.getManifestByVersion(version);
      if (!manifestEntry) {
        NodeStore.clearNodeVerification(node_id);
        return res.status(400).json({ error: "Unknown version", version });
      }

      const manifest = manifestEntry.manifest as Manifest;
      const assets: ManifestAsset[] = manifest.assets || [];
      const matchingAsset = assets.find(
        (a: ManifestAsset) => a.platform === platform && a.sha256 === build_digest
      );

      if (!matchingAsset) {
        NodeStore.clearNodeVerification(node_id);
        return res.json({
          verified: false,
          reason: "Build digest does not match any known asset for this platform",
          expected_platforms: assets.map((a: ManifestAsset) => a.platform),
        });
      }

      // Mark node as verified
      NodeStore.updateNodeVerification(node_id, true, version, build_digest);

      console.log(`[Updater] Node ${node_id} verified: v${version} (${platform})`);

      res.json({
        verified: true,
        version,
        platform,
        build_digest,
      });
    } catch (error: any) {
      console.error("Verify integrity error:", error);
      res.status(500).json({ error: "Integrity verification failed", message: error.message });
    }
  });

  /**
   * POST /admin/manifest
   * Admin uploads a signed manifest. Protected by x-admin-key header.
   * Body: { manifest: {...}, signature: "base64...", required: true/false }
   */
  app.post("/admin/manifest", (req: Request, res: Response) => {
    try {
      if (!adminKey) {
        return res.status(503).json({ error: "Admin key not configured" });
      }

      const providedKey = req.headers["x-admin-key"] as string | undefined;
      if (providedKey !== adminKey) {
        return res.status(403).json({ error: "Invalid admin key" });
      }

      const { manifest, signature, required } = req.body;

      if (!manifest || !signature) {
        return res.status(400).json({
          error: "Missing required fields",
          required: ["manifest", "signature"],
        });
      }

      if (!manifest.version || !manifest.assets || !Array.isArray(manifest.assets)) {
        return res.status(400).json({
          error: "Invalid manifest: must include version and assets array",
        });
      }

      // Store the manifest with its signature
      const fullManifest: Manifest = { ...manifest, signature };
      const github_url: string | null = manifest.github_release_url || null;

      NodeStore.upsertManifest(
        manifest.version,
        fullManifest,
        github_url,
        required !== false
      );

      console.log(`[Updater] Manifest stored: v${manifest.version} (required: ${required !== false})`);

      res.json({
        success: true,
        version: manifest.version,
        required: required !== false,
        assets: manifest.assets.length,
      });
    } catch (error: any) {
      console.error("Admin manifest error:", error);
      res.status(500).json({ error: "Failed to store manifest", message: error.message });
    }
  });
}
