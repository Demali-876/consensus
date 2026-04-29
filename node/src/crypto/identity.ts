import crypto from "node:crypto";
import fs from "node:fs/promises";
import { ensureState, exists } from "../node/state";

export interface NodeIdentity {
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function loadOrCreateIdentity(): Promise<NodeIdentity> {
  const p = await ensureState();
  if ((await exists(p.privateKeyPem)) && (await exists(p.publicKeyPem))) {
    return {
      privateKeyPem: await fs.readFile(p.privateKeyPem, "utf8"),
      publicKeyPem: await fs.readFile(p.publicKeyPem, "utf8")
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  await fs.writeFile(p.privateKeyPem, privateKey, { mode: 0o600 });
  await fs.writeFile(p.publicKeyPem, publicKey);

  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function signUtf8(privateKeyPem: string, payload: string): string {
  return signBytes(privateKeyPem, Buffer.from(payload, "utf8"));
}

export function signBytes(privateKeyPem: string, payload: Buffer): string {
  return crypto.sign(null, payload, privateKeyPem).toString("base64");
}

export function verifyUtf8(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
  return crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    publicKeyPem,
    Buffer.from(signatureBase64, "base64")
  );
}
