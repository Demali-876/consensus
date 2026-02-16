import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { createWriteStream, createReadStream } from "fs";
import { createGunzip } from "zlib";

// Pinned Ed25519 public key for manifest signature verification.
// Replace this with the actual public key generated via:
//   openssl genpkey -algorithm ED25519 -out manifest-signing.key
//   openssl pkey -in manifest-signing.key -pubout -out manifest-signing.pub
const MANIFEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPLACCE_PLACEHOLDER_REPLACE_WITH_REAL_KEY==
-----END PUBLIC KEY-----`;

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
  signature: string;
}

interface UpdaterConfig {
  gatewayUrl: string;
  nodeId: string;
  instanceRoot: string;
  privateKeyPath: string;
}

/**
 * Deterministically canonicalize a manifest for signature verification.
 * Excludes the `signature` field and sorts keys.
 */
function canonicalizeManifest(manifest: Manifest): string {
  const { signature, ...rest } = manifest;
  const sortedKeys = Object.keys(rest).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = (rest as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Get the platform string for this machine (e.g., "darwin-arm64", "linux-x64").
 */
function getPlatform(): string {
  return `${os.platform()}-${os.arch()}`;
}

/**
 * Compare semver strings. Returns true if a > b.
 */
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

export class NodeUpdater {
  private gatewayUrl: string;
  private nodeId: string;
  private instanceRoot: string;
  private privateKeyPath: string;
  private buildDigest: string | null = null;

  constructor(config: UpdaterConfig) {
    this.gatewayUrl = config.gatewayUrl;
    this.nodeId = config.nodeId;
    this.instanceRoot = config.instanceRoot;
    this.privateKeyPath = config.privateKeyPath;
  }

  /**
   * Get the current version from the instance's package.json.
   */
  async getCurrentVersion(): Promise<string> {
    const pkgPath = path.join(this.instanceRoot, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    return pkg.version;
  }

  /**
   * Load the persisted build digest from disk (saved after last update).
   */
  async loadBuildDigest(): Promise<string | null> {
    try {
      const digestPath = path.join(this.instanceRoot, ".build-digest");
      const digest = (await fs.readFile(digestPath, "utf8")).trim();
      this.buildDigest = digest;
      return digest;
    } catch {
      return null;
    }
  }

  /**
   * Persist the build digest to disk.
   */
  private async saveBuildDigest(digest: string): Promise<void> {
    const digestPath = path.join(this.instanceRoot, ".build-digest");
    await fs.writeFile(digestPath, digest, "utf8");
    this.buildDigest = digest;
  }

  /**
   * Verify a manifest's Ed25519 signature using the pinned public key.
   */
  verifyManifestSignature(manifest: Manifest): boolean {
    try {
      const canonical = canonicalizeManifest(manifest);
      const data = Buffer.from(canonical, "utf8");
      const sig = Buffer.from(manifest.signature, "base64");
      const pubkey = crypto.createPublicKey(MANIFEST_PUBLIC_KEY_PEM);
      return crypto.verify(null, data, pubkey, sig);
    } catch (err) {
      console.error("[Updater] Manifest signature verification error:", (err as Error).message);
      return false;
    }
  }

  /**
   * Check the server for a newer version.
   * Returns the manifest if an update is available, null otherwise.
   */
  async checkForUpdate(): Promise<Manifest | null> {
    try {
      const res = await fetch(`${this.gatewayUrl}/update/latest`);
      if (!res.ok) {
        if (res.status === 404) return null; // No required version set
        console.error(`[Updater] Check failed: ${res.status} ${res.statusText}`);
        return null;
      }

      const manifest: Manifest = await res.json() as Manifest;

      // Verify signature
      if (!this.verifyManifestSignature(manifest)) {
        console.error("[Updater] Manifest signature verification FAILED — ignoring update");
        return null;
      }

      // Compare versions
      const currentVersion = await this.getCurrentVersion();
      if (!isNewerVersion(manifest.version, currentVersion)) {
        return null; // Already up to date or downgrade attempt
      }

      return manifest;
    } catch (err) {
      console.error("[Updater] Check for update error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Download a release asset and verify its SHA256 digest.
   * Returns the path to the downloaded file.
   */
  private async downloadAsset(asset: ManifestAsset): Promise<{ filePath: string; digest: string }> {
    const stagingDir = path.join(this.instanceRoot, ".update-staging");
    await fs.mkdir(stagingDir, { recursive: true });

    const fileName = `release-${Date.now()}.tar.gz`;
    const filePath = path.join(stagingDir, fileName);

    const res = await fetch(asset.url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }

    // Stream to disk
    const fileStream = createWriteStream(filePath);
    // @ts-ignore - ReadableStream to Writable pipe via pipeline
    await pipeline(res.body, fileStream);

    // Compute SHA256
    const hash = crypto.createHash("sha256");
    const readStream = createReadStream(filePath);
    for await (const chunk of readStream) {
      hash.update(chunk);
    }
    const digest = `sha256:${hash.digest("hex")}`;

    return { filePath, digest };
  }

  /**
   * Download the matching release asset, verify its digest, and install atomically.
   */
  async downloadAndApply(manifest: Manifest): Promise<void> {
    const platform = getPlatform();
    const asset = manifest.assets.find((a) => a.platform === platform);

    if (!asset) {
      throw new Error(`No release asset for platform: ${platform}. Available: ${manifest.assets.map((a) => a.platform).join(", ")}`);
    }

    console.log(`[Updater] Downloading v${manifest.version} for ${platform}...`);

    const { filePath, digest } = await this.downloadAsset(asset);

    // Verify digest
    if (digest !== asset.sha256) {
      await fs.rm(filePath, { force: true });
      throw new Error(`Digest mismatch! Expected ${asset.sha256}, got ${digest}`);
    }

    console.log(`[Updater] Digest verified: ${digest}`);

    // Atomic install: extract to versioned directory, update symlink
    const versionsDir = path.join(this.instanceRoot, "runtime", "versions");
    const versionDir = path.join(versionsDir, manifest.version);
    const currentLink = path.join(this.instanceRoot, "runtime", "current");

    await fs.mkdir(versionDir, { recursive: true });

    // Extract tarball
    console.log(`[Updater] Extracting to ${versionDir}...`);
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    await execAsync(`tar -xzf "${filePath}" -C "${versionDir}" --strip-components=1`);

    // Update symlink atomically (create temp link, then rename)
    const tmpLink = `${currentLink}.tmp.${Date.now()}`;
    try {
      await fs.symlink(versionDir, tmpLink);
      await fs.rename(tmpLink, currentLink);
    } catch (linkError) {
      // If symlink fails (e.g., Windows), fall back to writing a pointer file
      await fs.rm(tmpLink, { force: true });
      await fs.mkdir(path.dirname(currentLink), { recursive: true });
      await fs.writeFile(currentLink, versionDir, "utf8");
    }

    // Save build digest
    await this.saveBuildDigest(digest);

    // Cleanup staging
    await fs.rm(filePath, { force: true });

    console.log(`[Updater] Installed v${manifest.version} successfully`);
  }

  /**
   * Report integrity to the server.
   * Signs the payload with the node's Ed25519 private key.
   */
  async reportIntegrity(): Promise<{ verified: boolean }> {
    const version = await this.getCurrentVersion();
    const platform = getPlatform();
    const buildDigest = this.buildDigest || (await this.loadBuildDigest());

    if (!buildDigest) {
      console.log("[Updater] No build digest found — skipping integrity report");
      return { verified: false };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");

    // Canonicalize payload for signing
    const payloadObj = { version, platform, build_digest: buildDigest, timestamp, nonce };
    const payloadStr = JSON.stringify(payloadObj, ["version", "platform", "build_digest", "timestamp", "nonce"]);
    const payloadBuffer = Buffer.from(payloadStr, "utf8");

    // Sign with node's Ed25519 private key
    let signature: string;
    try {
      const privateKeyPem = await fs.readFile(this.privateKeyPath, "utf8");
      const privateKey = crypto.createPrivateKey(privateKeyPem);
      const sig = crypto.sign(null, payloadBuffer, privateKey);
      signature = sig.toString("base64");
    } catch (err) {
      console.error("[Updater] Failed to sign integrity report:", (err as Error).message);
      return { verified: false };
    }

    try {
      const res = await fetch(`${this.gatewayUrl}/node/verify-integrity/${this.nodeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payloadObj, signature }),
      });

      const result = await res.json() as { verified: boolean };
      return result;
    } catch (err) {
      console.error("[Updater] Integrity report failed:", (err as Error).message);
      return { verified: false };
    }
  }

  /**
   * Restart the process. Relies on a process manager (PM2/systemd) to restart.
   */
  restart(): never {
    console.log("[Updater] Restarting node process...");
    process.exit(0);
  }
}
