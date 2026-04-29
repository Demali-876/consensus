import crypto from "node:crypto";
import os from "node:os";
import { canonicalJson } from "../crypto/canonical-json";
import { NODE_CAPABILITIES } from "../runtime/capabilities";
import type { ReleaseManifest } from "../types";

export const REQUIRED_ROUTES = [
  "GET /health",
  "GET /node/version",
  "GET /node/manifest",
  "GET /node/integrity",
  "GET /node/capabilities",
  "POST /benchmark/fetch",
  "POST /benchmark/cpu",
  "GET /benchmark/system",
  "POST /proxy"
] as const;

export function platform(): string {
  return `${os.platform()}-${os.arch()}`;
}

export function routesHash(): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson([...REQUIRED_ROUTES])).digest("hex")}`;
}

export function releaseManifest(): ReleaseManifest {
  return {
    product: "consensus-node",
    version: process.env.CONSENSUS_NODE_VERSION || "0.1.0-alpha.0",
    artifact: "npm-tarball",
    platform: platform(),
    commit: process.env.CONSENSUS_NODE_COMMIT || "dev",
    download_url: process.env.CONSENSUS_NODE_DOWNLOAD_URL,
    tarball_sha256: process.env.CONSENSUS_NODE_TARBALL_SHA256,
    routes_hash: routesHash(),
    capabilities: NODE_CAPABILITIES,
    signing_key_id: process.env.CONSENSUS_RELEASE_SIGNING_KEY_ID,
    signature: process.env.CONSENSUS_RELEASE_SIGNATURE
  };
}
