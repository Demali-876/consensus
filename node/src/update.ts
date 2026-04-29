import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { releaseManifest } from "./node/manifest";
import { ensureState } from "./node/state";
import type { ReleaseManifest } from "./types";

interface UpdateStatus {
  update_required: boolean;
  current: ReleaseManifest;
  required: ReleaseManifest;
  reasons: string[];
}

async function main(): Promise<void> {
  const serverUrl = process.env.CONSENSUS_SERVER_URL?.trim();
  if (!serverUrl) throw new Error("Missing CONSENSUS_SERVER_URL");

  const required = await fetchRequiredManifest(serverUrl);
  const current = releaseManifest();
  const status = compareManifests(current, required);

  if (!status.update_required) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!process.argv.includes("--download")) {
    console.log(JSON.stringify({
      ...status,
      next_step: "Run `bun run update -- --download` to download and verify the required artifact.",
    }, null, 2));
    return;
  }

  const downloaded = await downloadAndVerify(required);
  console.log(JSON.stringify({
    ...status,
    downloaded,
  }, null, 2));
}

async function fetchRequiredManifest(serverUrl: string): Promise<ReleaseManifest> {
  const response = await fetch(`${trimTrailingSlash(serverUrl)}/update/latest`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch required manifest: HTTP ${response.status}`);
  }

  const body = await response.json() as ReleaseManifest;
  if (body.product !== "consensus-node") {
    throw new Error("Required manifest is not for consensus-node");
  }
  return body;
}

export function compareManifests(current: ReleaseManifest, required: ReleaseManifest): UpdateStatus {
  const reasons: string[] = [];
  if (current.version !== required.version) reasons.push("version");
  if (current.platform !== required.platform) reasons.push("platform");
  if (current.commit !== required.commit) reasons.push("commit");
  if (current.routes_hash !== required.routes_hash) reasons.push("routes_hash");
  if (required.tarball_sha256 && current.tarball_sha256 !== required.tarball_sha256) {
    reasons.push("tarball_sha256");
  }

  return {
    update_required: reasons.length > 0,
    current,
    required,
    reasons,
  };
}

async function downloadAndVerify(manifest: ReleaseManifest): Promise<{ path: string; sha256: string }> {
  if (!manifest.download_url) {
    throw new Error("Required manifest does not include download_url");
  }

  const response = await fetch(manifest.download_url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download update artifact: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (manifest.tarball_sha256 && sha256 !== stripShaPrefix(manifest.tarball_sha256)) {
    throw new Error(`Artifact SHA-256 mismatch: expected ${manifest.tarball_sha256}, got ${sha256}`);
  }

  const state = await ensureState();
  const downloadsDir = path.join(state.base, "downloads");
  await fs.mkdir(downloadsDir, { recursive: true });
  const outputPath = path.join(downloadsDir, `consensus-node-${manifest.version}-${manifest.platform}.tgz`);
  await fs.writeFile(outputPath, bytes, { mode: 0o600 });

  return { path: outputPath, sha256 };
}

function stripShaPrefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error("Update failed:", error);
  process.exit(1);
});
