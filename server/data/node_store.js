// data/node_store.js
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
  capabilities TEXT,            -- JSON
  contact TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  domain TEXT,
  tls_mode TEXT
);

CREATE TABLE IF NOT EXISTS heartbeats (
  node_id TEXT NOT NULL,
  rps INTEGER,
  p95_ms INTEGER,
  version TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS heartbeats_node_created_idx
  ON heartbeats(node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  node_pubkey BLOB NOT NULL,
  alg TEXT NOT NULL,
  nonce BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
`);

const nowSec = () => Math.floor(Date.now() / 1000);

// --- Helpers ---
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

// --- Prepared statements ---
const upsertNodeInsertStmt = db.prepare(`
  INSERT INTO nodes (id, pubkey, alg, region, capabilities, contact, status, created_at, updated_at, domain, tls_mode)
  VALUES (@id, @pubkey, @alg, @region, @capabilities, @contact, @status, @created_at, @updated_at, NULL, NULL)
  ON CONFLICT(id) DO UPDATE SET
    pubkey=excluded.pubkey,
    alg=excluded.alg,
    region=excluded.region,
    capabilities=excluded.capabilities,
    contact=excluded.contact,
    status=excluded.status,
    updated_at=excluded.updated_at
`);

const updateDomainStmt = db.prepare(`
  UPDATE nodes
  SET domain = ?, tls_mode = ?, updated_at = ?
  WHERE id = ?
`);

const getNodeStmt = db.prepare(`
  SELECT
    n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.status,
    n.created_at, n.updated_at, n.domain, n.tls_mode
  FROM nodes n
  WHERE n.id = ?
`);

const insertHeartbeatStmt = db.prepare(`
  INSERT INTO heartbeats (node_id, rps, p95_ms, version, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const touchNodeStmt = db.prepare(`
  UPDATE nodes SET updated_at = ? WHERE id = ?
`);

const listNodesWithLatestHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.status,
    n.created_at, n.updated_at, n.domain, n.tls_mode,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN (
    SELECT h.*
    FROM heartbeats h
    WHERE h.rowid IN (
      SELECT MAX(rowid) FROM heartbeats GROUP BY node_id
    )
  ) hb ON hb.node_id = n.id
  ORDER BY n.created_at DESC
`);

const getNodeWithLatestHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey, n.alg, n.region, n.capabilities, n.contact, n.status,
    n.created_at, n.updated_at, n.domain, n.tls_mode,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN (
    SELECT h.*
    FROM heartbeats h
    WHERE h.node_id = ?
    ORDER BY h.rowid DESC
    LIMIT 1
  ) hb ON hb.node_id = n.id
  WHERE n.id = ?
`);


const insertJoinStmt = db.prepare(`
  INSERT INTO join_requests (id, node_pubkey, alg, nonce, expires_at, consumed_at)
  VALUES (?, ?, ?, ?, ?, NULL)
`);

const getJoinStmt = db.prepare(`
  SELECT id, node_pubkey, alg, nonce, expires_at, consumed_at
  FROM join_requests
  WHERE id = ?
`);

const consumeJoinStmt = db.prepare(`
  UPDATE join_requests
  SET consumed_at = ?
  WHERE id = ? AND consumed_at IS NULL
`);

function rowToNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    pubkey: row.pubkey,                 // Buffer
    alg: row.alg,
    region: row.region,
    capabilities: fromJson(row.capabilities, {}),
    contact: row.contact,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    domain: row.domain,
    tls_mode: row.tls_mode,
    heartbeat: row.hb_at ? {
      rps: row.hb_rps,
      p95_ms: row.hb_p95_ms,
      version: row.hb_version,
      at: row.hb_at
    } : null
  };
}

// --- API ---
export const NodeStore = {
  // Create or update a node
  upsertNode(input) {
    const ts = nowSec();
    const payload = {
      id: input.id,
      pubkey: input.pubkey,
      alg: input.alg,
      region: input.region ?? null,
      capabilities: toJson(input.capabilities ?? {}),
      contact: input.contact ?? null,
      status: input.status ?? 'provisioning',
      created_at: ts,
      updated_at: ts
    };
    upsertNodeInsertStmt.run(payload);
    return this.getNode(input.id); // return fresh record with latest heartbeat if any
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

  // --- Join flow ---
  createJoinRequest({ pubkey, alg, ttlSeconds = 300 }) {
    const id = crypto.randomBytes(8).toString('hex'); // e.g., 'cd6842fce6396c48'
    const nonce = crypto.randomBytes(32);
    const expires_at = nowSec() + Math.max(60, ttlSeconds);

    insertJoinStmt.run(id, pubkey, alg, nonce, expires_at);

    return {
      id,
      nonce: b64url(nonce), // base64url string for transport
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
      nonce: row.nonce,                 // Buffer
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
  }
};

export default NodeStore;
