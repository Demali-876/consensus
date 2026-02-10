// src/state.ts
import fs from "fs/promises";
import path from "path";

export type StatePaths = {
  base: string;

  config: string;
  keysDir: string;
  certsDir: string;

  privateKeyPem: string;
  publicKeyPem: string;

  nodeCrt: string;
  nodeKey: string;
  caCrt: string;
};

export function stateDir(): string {
  return process.env.CONSENSUS_STATE_DIR || "/var/lib/consensus/node";
}

export function paths(): StatePaths {
  const base = stateDir();
  return {
    base,
    config: path.join(base, "config.json"),
    keysDir: path.join(base, "keys"),
    certsDir: path.join(base, "certs"),
    privateKeyPem: path.join(base, "keys", "node.key"),
    publicKeyPem: path.join(base, "keys", "node.pub"),
    nodeCrt: path.join(base, "certs", "node.crt"),
    nodeKey: path.join(base, "certs", "node.key"),
    caCrt: path.join(base, "certs", "ca.crt"),
  };
}

export async function ensureState(): Promise<StatePaths> {
  const p = paths();
  await fs.mkdir(p.base, { recursive: true });
  await fs.mkdir(p.keysDir, { recursive: true });
  await fs.mkdir(p.certsDir, { recursive: true });
  return p;
}

export async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
