import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/log.ts';

const DB_PATH = process.env.NODE_DB_PATH || path.resolve(process.cwd(), 'consensus.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── Migration ────────────────────────────────────────────────────────────────

// If the old schema exists (identifiable by the 'alg' column), drop everything
// and start fresh. No nodes are stored so there is nothing to preserve.
const oldColumns = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
if (oldColumns.includes('alg') || oldColumns.includes('tls_mode')) {
  db.exec(`
    DROP TABLE IF EXISTS heartbeats;
    DROP TABLE IF EXISTS join_requests;
    DROP TABLE IF EXISTS nodes;
  `);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id                TEXT PRIMARY KEY,
    pubkey_secp256k1  BLOB,
    pubkey_ed25519    BLOB,
    region            TEXT NOT NULL,
    contact           TEXT NOT NULL,
    capabilities      TEXT,
    evm_address       TEXT,
    solana_address    TEXT,
    icp_address       TEXT,
    status            TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    domain            TEXT,
    CHECK (pubkey_secp256k1 IS NOT NULL OR pubkey_ed25519 IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS nodes_evm_address_idx      ON nodes(evm_address);
  CREATE INDEX IF NOT EXISTS nodes_solana_address_idx   ON nodes(solana_address);
  CREATE INDEX IF NOT EXISTS nodes_icp_address_idx      ON nodes(icp_address);

  CREATE TABLE IF NOT EXISTS heartbeats (
    node_id     TEXT    PRIMARY KEY,
    rps         INTEGER,
    p95_ms      INTEGER,
    version     TEXT,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE INDEX IF NOT EXISTS heartbeats_node_created_idx ON heartbeats(node_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS join_requests (
    id          TEXT    PRIMARY KEY,
    node_pubkey BLOB    NOT NULL,
    alg         TEXT    NOT NULL,
    nonce       BLOB    NOT NULL,
    benchmark_score INTEGER,
    benchmark_details TEXT,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS release_manifests (
    version     TEXT PRIMARY KEY,
    manifest    TEXT NOT NULL,
    github_url  TEXT,
    required    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    token_hash  TEXT,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS email_verifications_token_idx ON email_verifications(token_hash);
`);

for (const statement of [
  'ALTER TABLE join_requests ADD COLUMN benchmark_score INTEGER',
  'ALTER TABLE join_requests ADD COLUMN benchmark_details TEXT',
]) {
  try {
    db.exec(statement);
  } catch (error) {
    if (!String(error?.message ?? '').includes('duplicate column name')) throw error;
  }
}

try {
  const heartbeatColumns = db.prepare('PRAGMA table_info(heartbeats)').all();
  const nodeIdColumn = heartbeatColumns.find((column) => column.name === 'node_id');
  if (nodeIdColumn && !nodeIdColumn.pk) {
    log.info('node-store', 'heartbeat-migration-start', {});
    db.exec(`
      DROP TABLE IF EXISTS heartbeats_latest;
      CREATE TABLE IF NOT EXISTS heartbeats_latest (
        node_id     TEXT PRIMARY KEY,
        rps         INTEGER,
        p95_ms      INTEGER,
        version     TEXT,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
      INSERT OR REPLACE INTO heartbeats_latest (node_id, rps, p95_ms, version, created_at)
      SELECT h.node_id, h.rps, h.p95_ms, h.version, h.created_at
      FROM heartbeats h
      INNER JOIN (
        SELECT node_id, MAX(rowid) AS rowid FROM heartbeats GROUP BY node_id
      ) latest ON latest.rowid = h.rowid;
      DROP TABLE heartbeats;
      ALTER TABLE heartbeats_latest RENAME TO heartbeats;
      CREATE INDEX IF NOT EXISTS heartbeats_node_created_idx ON heartbeats(node_id, created_at DESC);
    `);
    log.info('node-store', 'heartbeat-migration-complete', {});
  }
} catch (error) {
  log.error('node-store', 'heartbeat-migration-failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function fromJson(value, fallback) {
  if (!value) return fallback ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return fallback ?? null;
  }
}

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const upsertNodeStmt = db.prepare(`
  INSERT INTO nodes (
    id, pubkey_secp256k1, pubkey_ed25519, region, contact,
    capabilities, evm_address, solana_address, icp_address,
    status, created_at, updated_at, domain
  ) VALUES (
    @id, @pubkey_secp256k1, @pubkey_ed25519, @region, @contact,
    @capabilities, @evm_address, @solana_address, @icp_address,
    @status, @created_at, @updated_at, NULL
  )
  ON CONFLICT(id) DO UPDATE SET
    pubkey_secp256k1 = excluded.pubkey_secp256k1,
    pubkey_ed25519   = excluded.pubkey_ed25519,
    region           = excluded.region,
    contact          = excluded.contact,
    capabilities     = excluded.capabilities,
    evm_address      = excluded.evm_address,
    solana_address   = excluded.solana_address,
    icp_address      = excluded.icp_address,
    status           = excluded.status,
    updated_at       = excluded.updated_at
`);

const updateDomainStmt = db.prepare(`
  UPDATE nodes SET domain = ?, updated_at = ? WHERE id = ?
`);

const getNodeWithHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey_secp256k1, n.pubkey_ed25519, n.region, n.contact,
    n.capabilities, n.evm_address, n.solana_address, n.icp_address,
    n.status, n.created_at, n.updated_at, n.domain,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN heartbeats hb ON hb.node_id = n.id
  WHERE n.id = ?
`);

const listNodesWithHeartbeatStmt = db.prepare(`
  SELECT
    n.id, n.pubkey_secp256k1, n.pubkey_ed25519, n.region, n.contact,
    n.capabilities, n.evm_address, n.solana_address, n.icp_address,
    n.status, n.created_at, n.updated_at, n.domain,
    hb.rps AS hb_rps, hb.p95_ms AS hb_p95_ms, hb.version AS hb_version, hb.created_at AS hb_at
  FROM nodes n
  LEFT JOIN heartbeats hb ON hb.node_id = n.id
  ORDER BY n.created_at DESC
`);

const insertHeartbeatStmt = db.prepare(`
  INSERT INTO heartbeats (node_id, rps, p95_ms, version, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(node_id) DO UPDATE SET
    rps = excluded.rps,
    p95_ms = excluded.p95_ms,
    version = excluded.version,
    created_at = excluded.created_at
`);

const touchNodeStmt = db.prepare(`
  UPDATE nodes SET updated_at = ? WHERE id = ?
`);

const insertJoinStmt = db.prepare(`
  INSERT INTO join_requests (id, node_pubkey, alg, nonce, benchmark_score, benchmark_details, expires_at, consumed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
`);

const getJoinStmt = db.prepare(`
  SELECT id, node_pubkey, alg, nonce, benchmark_score, benchmark_details, expires_at, consumed_at FROM join_requests WHERE id = ?
`);

const consumeJoinStmt = db.prepare(`
  UPDATE join_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
`);

const deleteNodeStmt = db.prepare(`
  DELETE FROM nodes WHERE id = ?
`);

const deleteNodeHeartbeatsStmt = db.prepare(`
  DELETE FROM heartbeats WHERE node_id = ?
`);

const upsertManifestStmt = db.prepare(`
  INSERT INTO release_manifests (version, manifest, github_url, required, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(version) DO UPDATE SET
    manifest = excluded.manifest,
    github_url = excluded.github_url,
    required = excluded.required,
    created_at = excluded.created_at
`);

const getRequiredManifestStmt = db.prepare(`
  SELECT version, manifest, github_url, required, created_at
  FROM release_manifests
  WHERE required = 1
  ORDER BY created_at DESC
  LIMIT 1
`);

const getManifestByVersionStmt = db.prepare(`
  SELECT version, manifest, github_url, required, created_at
  FROM release_manifests
  WHERE version = ?
`);

const insertEmailVerificationStmt = db.prepare(`
  INSERT INTO email_verifications (id, email, code_hash, attempts, token_hash, expires_at, consumed_at, created_at)
  VALUES (?, ?, ?, 0, NULL, ?, NULL, ?)
`);

const getEmailVerificationStmt = db.prepare(`
  SELECT id, email, code_hash, attempts, token_hash, expires_at, consumed_at, created_at
  FROM email_verifications
  WHERE id = ?
`);

const getEmailVerificationByTokenStmt = db.prepare(`
  SELECT id, email, code_hash, attempts, token_hash, expires_at, consumed_at, created_at
  FROM email_verifications
  WHERE token_hash = ?
`);

const incrementEmailVerificationAttemptsStmt = db.prepare(`
  UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?
`);

const consumeEmailVerificationStmt = db.prepare(`
  UPDATE email_verifications SET consumed_at = ?, token_hash = ? WHERE id = ? AND consumed_at IS NULL
`);

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToNode(row) {
  if (!row) return null;
  return {
    id:               row.id,
    pubkey_secp256k1: row.pubkey_secp256k1 ?? null,
    pubkey_ed25519:   row.pubkey_ed25519   ?? null,
    region:           row.region,
    contact:          row.contact,
    capabilities:     fromJson(row.capabilities, {}),
    evm_address:      row.evm_address,
    solana_address:   row.solana_address,
    icp_address:      row.icp_address,
    status:           row.status,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
    domain:           row.domain,
    heartbeat: row.hb_at
      ? { rps: row.hb_rps, p95_ms: row.hb_p95_ms, version: row.hb_version, at: row.hb_at }
      : null,
  };
}

function rowToManifest(row) {
  if (!row) return null;
  return {
    version: row.version,
    manifest: fromJson(row.manifest, {}),
    github_url: row.github_url,
    required: Boolean(row.required),
    created_at: row.created_at,
  };
}

function rowToEmailVerification(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    code_hash: row.code_hash,
    attempts: row.attempts,
    token_hash: row.token_hash,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at ?? null,
    created_at: row.created_at,
  };
}

// ─── NodeStore ────────────────────────────────────────────────────────────────

export const NodeStore = {
  /**
   * Insert or update a node. At least one of pubkey_secp256k1 / pubkey_ed25519
   * must be provided (enforced by the schema CHECK constraint).
   */
  upsertNode(input) {
    const ts = nowSec();
    upsertNodeStmt.run({
      id:               input.id,
      pubkey_secp256k1: input.pubkey_secp256k1 ?? null,
      pubkey_ed25519:   input.pubkey_ed25519   ?? null,
      region:           input.region,
      contact:          input.contact,
      capabilities:     toJson(input.capabilities ?? {}),
      evm_address:      input.evm_address      ?? null,
      solana_address:   input.solana_address   ?? null,
      icp_address:      input.icp_address      ?? null,
      status:           input.status           ?? 'provisioning',
      created_at:       ts,
      updated_at:       ts,
    });
    return this.getNode(input.id);
  },

  getNode(id) {
    return rowToNode(getNodeWithHeartbeatStmt.get(id));
  },

  listNodes() {
    return listNodesWithHeartbeatStmt.all().map(rowToNode);
  },

  setDomain(id, domain) {
    const res = updateDomainStmt.run(domain, nowSec(), id);
    if (res.changes === 0) throw new Error(`Node not found: ${id}`);
    return this.getNode(id);
  },

  heartbeat(id, { rps = null, p95_ms = null, version = null } = {}) {
    const ts = nowSec();
    insertHeartbeatStmt.run(id, rps, p95_ms, version, ts);
    touchNodeStmt.run(ts, id);
    log.info('node-store', 'heartbeat-upserted', {
      node_id: id,
      rps,
      p95_ms,
      version,
      at: ts,
    });
    return this.getNode(id);
  },

  updateNodeVerification(id, verified, version, build_digest) {
    const node = this.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    const capabilities = {
      ...(node.capabilities ?? {}),
      verified: Boolean(verified),
      verified_version: version,
      build_digest,
      verified_at: nowSec(),
    };
    const ts = nowSec();
    db.prepare('UPDATE nodes SET capabilities = ?, updated_at = ? WHERE id = ?')
      .run(toJson(capabilities), ts, id);
    log.info('node-store', 'verification-updated', {
      node_id: id,
      verified: Boolean(verified),
      version,
      build_digest,
    });
    return this.getNode(id);
  },

  clearNodeVerification(id) {
    const node = this.getNode(id);
    if (!node) return null;
    const capabilities = { ...(node.capabilities ?? {}) };
    delete capabilities.verified;
    delete capabilities.verified_version;
    delete capabilities.build_digest;
    delete capabilities.verified_at;
    const ts = nowSec();
    db.prepare('UPDATE nodes SET capabilities = ?, updated_at = ? WHERE id = ?')
      .run(toJson(capabilities), ts, id);
    log.info('node-store', 'verification-cleared', { node_id: id });
    return this.getNode(id);
  },

  setNodeUpdateState(id, state, details = {}) {
    const node = this.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    const capabilities = { ...(node.capabilities ?? {}) };
    if (state == null) {
      delete capabilities.update_state;
      delete capabilities.update_id;
      delete capabilities.update_target_version;
      delete capabilities.update_reason;
      delete capabilities.update_at;
    } else {
      capabilities.update_state = state;
      capabilities.update_id = details.update_id ?? capabilities.update_id ?? null;
      capabilities.update_target_version = details.target_version ?? capabilities.update_target_version ?? null;
      capabilities.update_reason = details.reason ?? null;
      capabilities.update_at = nowSec();
    }
    const ts = nowSec();
    db.prepare('UPDATE nodes SET capabilities = ?, updated_at = ? WHERE id = ?')
      .run(toJson(capabilities), ts, id);
    log.info('node-store', 'update-state-set', {
      node_id: id,
      state,
      update_id: details.update_id ?? null,
      target_version: details.target_version ?? null,
      reason: details.reason ?? null,
    });
    return this.getNode(id);
  },

  createJoinRequest({ pubkey, alg, ttlSeconds = 300, benchmarkScore = null, benchmarkDetails = null }) {
    const id        = crypto.randomBytes(8).toString('hex');
    const nonce     = crypto.randomBytes(32);
    const expires_at = nowSec() + Math.max(60, ttlSeconds);
    insertJoinStmt.run(id, pubkey, alg, nonce, benchmarkScore, toJson(benchmarkDetails), expires_at);
    return { id, nonce: b64url(nonce), alg, expires_at };
  },

  getJoin(id) {
    const row = getJoinStmt.get(id);
    if (!row) return null;
    return {
      id:          row.id,
      node_pubkey: row.node_pubkey,
      alg:         row.alg,
      nonce:       row.nonce,
      benchmark_score: row.benchmark_score ?? null,
      benchmark_details: fromJson(row.benchmark_details, null),
      expires_at:  row.expires_at,
      consumed_at: row.consumed_at ?? null,
      nonce_b64:   b64url(row.nonce),
    };
  },

  consumeJoin(id) {
    const res = consumeJoinStmt.run(nowSec(), id);
    if (res.changes === 0) throw new Error(`Join not found or already consumed: ${id}`);
    return this.getJoin(id);
  },

  deleteNode(id) {
    deleteNodeHeartbeatsStmt.run(id);
    const res = deleteNodeStmt.run(id);
    return res.changes > 0;
  },

  upsertManifest(version, manifest, github_url = null, required = true) {
    upsertManifestStmt.run(version, toJson(manifest), github_url, required ? 1 : 0, nowSec());
    log.info('node-store', 'manifest-upserted', {
      version,
      manifest_version: manifest?.version ?? null,
      platform: manifest?.platform ?? null,
      commit: manifest?.commit ?? null,
      required,
    });
    return this.getManifestByVersion(version);
  },

  getRequiredManifest() {
    return rowToManifest(getRequiredManifestStmt.get());
  },

  getManifestByVersion(version) {
    return rowToManifest(getManifestByVersionStmt.get(version));
  },

  createEmailVerification({ email, code_hash, ttlSeconds = 600 }) {
    const id = crypto.randomBytes(12).toString('hex');
    const created_at = nowSec();
    const expires_at = created_at + Math.max(60, ttlSeconds);
    insertEmailVerificationStmt.run(id, email, code_hash, expires_at, created_at);
    return this.getEmailVerification(id);
  },

  getEmailVerification(id) {
    return rowToEmailVerification(getEmailVerificationStmt.get(id));
  },

  getEmailVerificationByToken(tokenHash) {
    return rowToEmailVerification(getEmailVerificationByTokenStmt.get(tokenHash));
  },

  incrementEmailVerificationAttempts(id) {
    incrementEmailVerificationAttemptsStmt.run(id);
    return this.getEmailVerification(id);
  },

  consumeEmailVerification(id, tokenHash) {
    const result = consumeEmailVerificationStmt.run(nowSec(), tokenHash, id);
    if (result.changes === 0) throw new Error(`Email verification not found or already consumed: ${id}`);
    return this.getEmailVerification(id);
  },
};

export default NodeStore;
