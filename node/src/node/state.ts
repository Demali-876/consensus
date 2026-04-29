import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NodeConfig } from "../types";

export interface StatePaths {
  base: string;
  config: string;
  keysDir: string;
  privateKeyPem: string;
  publicKeyPem: string;
  manifest: string;
  joinAuth: string;
}

export function stateDir(): string {
  return process.env.CONSENSUS_STATE_DIR || path.join(os.homedir(), ".consensus", "node");
}

export function paths(): StatePaths {
  const base = stateDir();
  const keysDir = path.join(base, "keys");
  return {
    base,
    config: path.join(base, "config.json"),
    keysDir,
    privateKeyPem: path.join(keysDir, "node.key"),
    publicKeyPem: path.join(keysDir, "node.pub"),
    manifest: path.join(base, "release-manifest.json"),
    joinAuth: path.join(base, "join-auth.json")
  };
}

export async function ensureState(): Promise<StatePaths> {
  const p = paths();
  await fs.mkdir(p.base, { recursive: true });
  await fs.mkdir(p.keysDir, { recursive: true });
  return p;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

export async function loadConfig(): Promise<NodeConfig> {
  const p = await ensureState();
  return readJson<NodeConfig>(p.config, { port: Number(process.env.NODE_PORT || 9090) });
}

export async function saveConfig(config: NodeConfig): Promise<void> {
  const p = await ensureState();
  await writeJson(p.config, config);
}

export interface JoinAuthorization {
  join_id: string;
  alg: "ed25519";
  nonce: string;
  signature: string;
  expires_at: number;
  saved_at: string;
}

export async function saveJoinAuthorization(auth: JoinAuthorization): Promise<void> {
  const p = await ensureState();
  await fs.writeFile(p.joinAuth, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function loadJoinAuthorization(): Promise<JoinAuthorization | null> {
  const p = await ensureState();
  return readJson<JoinAuthorization | null>(p.joinAuth, null);
}
