import crypto from "node:crypto";
import { canonicalJson } from "../crypto/canonical-json";
import { loadOrCreateIdentity, signUtf8 } from "../crypto/identity";
import { releaseManifest } from "./manifest";
import type { IntegrityPayload } from "../types";

export async function integrityPayload(): Promise<IntegrityPayload> {
  const identity = await loadOrCreateIdentity();
  const unsigned = {
    product: "consensus-node" as const,
    version: releaseManifest().version,
    runtime: "bun" as const,
    platform: releaseManifest().platform,
    node_public_key_pem: identity.publicKeyPem,
    manifest: releaseManifest(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(16).toString("hex")
  };

  return {
    ...unsigned,
    signature: signUtf8(identity.privateKeyPem, canonicalJson(unsigned))
  };
}
