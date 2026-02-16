import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.NODE_DB_PATH || path.resolve(process.cwd(), 'consensus.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  pubkey BLOB NOT NULL,
  alg TEXT NOT NULL,
  region TEXT,
  capabilities TEXT,
  contact TEXT,
  evm_address TEXT,
  solana_address TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  domain TEXT,
  tls_mode TEXT
);

CREATE INDEX IF NOT EXISTS nodes_evm_address_idx ON nodes(evm_address);
CREATE INDEX IF NOT EXISTS nodes_solana_address_idx ON nodes(solana_address);

CREATE TABLE IF NOT EXISTS heartbeats (
  node_id TEXT NOT NULL,
  rps INTEGER,
  p95_ms INTEGER,
  version TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS heartbeats_node_created_idx ON heartbeats(node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  node_pubkey BLOB NOT NULL,
  alg TEXT NOT NULL,
  nonce BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS version_manifests (
  version TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  released_at INTEGER NOT NULL,
  github_release_url TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

// Safe column migrations — add new columns if they don't exist
const nodeColumns = db.pragma('table_info(nodes)').map(c => c.name);
if (!nodeColumns.includes('software_version')) {
  db.exec('ALTER TABLE nodes ADD COLUMN software_version TEXT');
}
if (!nodeColumns.includes('build_digest')) {
  db.exec('ALTER TABLE nodes ADD COLUMN build_digest TEXT');
}
if (!nodeColumns.includes('verified')) {
  db.exec('ALTER TABLE nodes ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
}
if (!nodeColumns.includes('last_verified_at')) {
  db.exec('ALTER TABLE nodes ADD COLUMN last_verified_at INTEGER');
}

const nowSec = () => Math.floor(Date.now() / 1000);

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function fromJson(value, fallback) {
  if (!value) return fallback ?? null;
  try { return JSON.parse(value); } catch { return fallback ?? null; }
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const upsertNodeInsertStmt = db.prepare(`
  INSERT INTO nodes (id, pubkey, alg, region, capabilities, contact, evm_address, solana_address, status, created_at, updated_at, domain, tls_mode)
  VALUES (@id, @pubkey, @alg, @region, @capabilities, @contact, @evm_address, @solana_address, @status, @created_at, @updated_at, NULL, NULL)
  ON CONFLICT(id) DO UPDATE SET
    pubkey=excluded.pubkey,
    alg=excluded.alg,
    region=excluded.region,
    capabilities=excluded.capabilities,
    contact=excluded.contact,
    evm_address=excluded.evm_address,
    solana_address=excluded.solana_address,
    status=excluded.status,
    updated_at=excluded.updated_at
`);

const updateDomainStmt = db.prepare(`
  UPDATE nodes SET domain = ?, tls_mode = ?, updated_at = ? WHERE id = ?
`);

const getNodeStmt = db.prepare(`
  SELECT n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.evm_address, n.solana_address, n.status, n.created_at, n.updated_at, n.domain, n.tls_mode
  FROM nodes n WHERE n.id = ?
`);

const insertHeartbeatStmt = db.prepare(`
  INSERT INTO heartbeats (node_id, rps, p95_ms, version, created_at) VALUES (?, ?, ?, ?, ?)
`);

const touchNodeStmt = db.prepare(`
  UPDATE nodes SET updated_at = ? WHERE id = ?
`);

const listNodesWithLatestHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.evm_address, n.solana_address, n.status,
    n.created_at, n.updated_at, n.domain, n.tls_mode,
    n.software_version, n.build_digest, n.verified, n.last_verified_at,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN (
    SELECT h.* FROM heartbeats h WHERE h.rowid IN (SELECT MAX(rowid) FROM heartbeats GROUP BY node_id)
  ) hb ON hb.node_id = n.id
  ORDER BY n.created_at DESC
`);

const getNodeWithLatestHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.evm_address, n.solana_address, n.status,
    n.created_at, n.updated_at, n.domain, n.tls_mode,
    n.software_version, n.build_digest, n.verified, n.last_verified_at,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN (
    SELECT h.* FROM heartbeats h WHERE h.node_id = ? ORDER BY h.rowid DESC LIMIT 1
  ) hb ON hb.node_id = n.id
  WHERE n.id = ?
`);

const insertJoinStmt = db.prepare(`
  INSERT INTO join_requests (id, node_pubkey, alg, nonce, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)
`);

const getJoinStmt = db.prepare(`
  SELECT id, node_pubkey, alg, nonce, expires_at, consumed_at FROM join_requests WHERE id = ?
`);

const consumeJoinStmt = db.prepare(`
  UPDATE join_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
`);

// Verification & manifest statements
const updateVerificationStmt = db.prepare(`
  UPDATE nodes SET software_version = ?, build_digest = ?, verified = ?, last_verified_at = ?, updated_at = ? WHERE id = ?
`);

const clearVerificationStmt = db.prepare(`
  UPDATE nodes SET verified = 0, updated_at = ? WHERE id = ?
`);

const upsertManifestStmt = db.prepare(`
  INSERT INTO version_manifests (version, manifest, released_at, github_release_url, required, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(version) DO UPDATE SET
    manifest=excluded.manifest,
    released_at=excluded.released_at,
    github_release_url=excluded.github_release_url,
    required=excluded.required
`);

const clearRequiredManifestsStmt = db.prepare(`
  UPDATE version_manifests SET required = 0 WHERE required = 1
`);

const getRequiredManifestStmt = db.prepare(`
  SELECT version, manifest, released_at, github_release_url, required, created_at FROM version_manifests WHERE required = 1 LIMIT 1
`);

const getManifestByVersionStmt = db.prepare(`
  SELECT version, manifest, released_at, github_release_url, required, created_at FROM version_manifests WHERE version = ?
`);

function rowToNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    pubkey: row.pubkey,
    alg: row.alg,
    region: row.region,
    capabilities: fromJson(row.capabilities, {}),
    contact: row.contact,
    evm_address: row.evm_address,
    solana_address: row.solana_address,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    domain: row.domain,
    tls_mode: row.tls_mode,
    software_version: row.software_version ?? null,
    build_digest: row.build_digest ?? null,
    verified: row.verified ?? 0,
    last_verified_at: row.last_verified_at ?? null,
    heartbeat: row.hb_at ? {
      rps: row.hb_rps,
      p95_ms: row.hb_p95_ms,
      version: row.hb_version,
      at: row.hb_at
    } : null
  };
}

export const NodeStore = {
  upsertNode(input) {
    const ts = nowSec();
    const payload = {
      id: input.id,
      pubkey: input.pubkey,
      alg: input.alg,
      region: input.region ?? null,
      capabilities: toJson(input.capabilities ?? {}),
      contact: input.contact ?? null,
      evm_address: input.evm_address ?? null,
      solana_address: input.solana_address ?? null,
      status: input.status ?? 'provisioning',
      created_at: ts,
      updated_at: ts
    };
    upsertNodeInsertStmt.run(payload);
    return this.getNode(input.id);
  },

  getNode(id) {
    const row = getNodeWithLatestHeartbeatStmt.get(id, id);
    return rowToNode(row);
  },

  listNodes() {
    const rows = listNodesWithLatestHeartbeatStmt.all();
    return rows.map(rowToNode);
  },

  setDomain(id, domain, tls_mode) {
    const ts = nowSec();
    const res = updateDomainStmt.run(domain, tls_mode, ts, id);
    if (res.changes === 0) throw new Error(`Node not found: ${id}`);
    return this.getNode(id);
  },

  heartbeat(id, { rps = null, p95_ms = null, version = null } = {}) {
    const ts = nowSec();
    insertHeartbeatStmt.run(id, rps, p95_ms, version, ts);
    touchNodeStmt.run(ts, id);
    return this.getNode(id);
  },

  createJoinRequest({ pubkey, alg, ttlSeconds = 300 }) {
    const id = crypto.randomBytes(8).toString('hex');
    const nonce = crypto.randomBytes(32);
    const expires_at = nowSec() + Math.max(60, ttlSeconds);
    insertJoinStmt.run(id, pubkey, alg, nonce, expires_at);
    return {
      id,
      nonce: b64url(nonce),
      alg,
      expires_at
    };
  },

  getJoin(id) {
    const row = getJoinStmt.get(id);
    if (!row) return null;
    return {
      id: row.id,
      node_pubkey: row.node_pubkey,
      alg: row.alg,
      nonce: row.nonce,
      expires_at: row.expires_at,
      consumed_at: row.consumed_at ?? null,
      nonce_b64: b64url(row.nonce)
    };
  },

  consumeJoin(id) {
    const ts = nowSec();
    const res = consumeJoinStmt.run(ts, id);
    if (res.changes === 0) {
      throw new Error(`Join not found or already consumed: ${id}`);
    }
    return this.getJoin(id);
  },

  updateNodeVerification(node_id, verified, software_version, build_digest) {
    const ts = nowSec();
    updateVerificationStmt.run(software_version, build_digest, verified ? 1 : 0, ts, ts, node_id);
    return this.getNode(node_id);
  },

  clearNodeVerification(node_id) {
    const ts = nowSec();
    clearVerificationStmt.run(ts, node_id);
  },

  upsertManifest(version, manifest_json, github_url, required) {
    const ts = nowSec();
    const manifest = typeof manifest_json === 'string' ? manifest_json : JSON.stringify(manifest_json);
    const parsed = typeof manifest_json === 'string' ? JSON.parse(manifest_json) : manifest_json;
    const released_at = parsed.released_at ? Math.floor(new Date(parsed.released_at).getTime() / 1000) : ts;

    if (required) {
      clearRequiredManifestsStmt.run();
    }
    upsertManifestStmt.run(version, manifest, released_at, github_url ?? null, required ? 1 : 0, ts);
  },

  getRequiredManifest() {
    const row = getRequiredManifestStmt.get();
    if (!row) return null;
    return {
      version: row.version,
      manifest: fromJson(row.manifest, {}),
      released_at: row.released_at,
      github_release_url: row.github_release_url,
      required: row.required,
      created_at: row.created_at,
    };
  },

  getManifestByVersion(version) {
    const row = getManifestByVersionStmt.get(version);
    if (!row) return null;
    return {
      version: row.version,
      manifest: fromJson(row.manifest, {}),
      released_at: row.released_at,
      github_release_url: row.github_release_url,
      required: row.required,
      created_at: row.created_at,
    };
  },
};

export default NodeStore;