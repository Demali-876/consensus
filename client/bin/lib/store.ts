/**
 * store.ts — single source of truth for all on-disk state.
 *
 * Directory layout:
 *   ~/.consensus/
 *     config.json       wallet addresses, api_key, leased node
 *     preferences.json  user defaults and UI settings
 *     sessions.json     session history (last 100)
 *     spending.json     per-session spending ledger
 *     nodes.json        cached node list (5-min TTL)
 *     bookmarks.json    saved proxy/tunnel targets
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

// ─── Directory ────────────────────────────────────────────────────────────────

export const CONSENSUS_DIR = path.join(os.homedir(), '.consensus');

function storePath(file: string): string {
  return path.join(CONSENSUS_DIR, file);
}

function ensureDir(): void {
  if (!fs.existsSync(CONSENSUS_DIR)) fs.mkdirSync(CONSENSUS_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(storePath(file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir();
  fs.writeFileSync(storePath(file), JSON.stringify(data, null, 2), 'utf8');
}

// ─── Schema: Config ───────────────────────────────────────────────────────────

export interface LeasedNode {
  domain:     string;
  node_id?:   string;
  region?:    string;
  leased_at:  string; // ISO
}

export interface ConsensusConfig {
  version?:        string;
  setup_date?:     string;
  wallet_name?:    string;
  wallet_type?:    'self-managed' | 'cdp-managed';
  addresses?: {
    evm?:    string;
    solana?: string;
    icp?:    string;
  };
  api_key?:        string;
  x402_proxy_url?: string;
  leased_node?:    LeasedNode | null;
}

export function loadConfig(): ConsensusConfig {
  // Migrate from legacy locations on first read
  migrateConfig();
  return readJson<ConsensusConfig>('config.json', {});
}

export function saveConfig(config: ConsensusConfig): void {
  writeJson('config.json', config);
}

// ─── Schema: Preferences ─────────────────────────────────────────────────────

export interface Preferences {
  // proxy
  defaultProxyPort:    number;
  defaultCacheTtl:     number;       // seconds; 0 = off
  defaultBudget?:      number;       // USD per session; undefined = unlimited
  defaultVerbose:      boolean;

  // routing
  defaultRegion?:      string;       // "us-east" | "eu-west" | ...
  defaultNetwork?:     string;       // CAIP-2 string
  defaultExcludeNode?: string;

  // tunnel
  defaultProtocol:     'http' | 'tcp';
  defaultTarget?:      string;

  // websocket
  defaultWsModel:      'time' | 'data' | 'hybrid';
  defaultWsMinutes:    number;
  defaultWsMegabytes:  number;
  /**
   * Friendly handle shown in the top-bar `acct` chip and the landing-page
   * `WELCOME BACK, ...` eyebrow. Wallet addresses and on-chain identity
   * stay in `ConsensusConfig` — this is purely a UI label. Falls back to
   * the PREFS_DEFAULTS value ('guest') when unset or blank.
   */
  displayName:         string;

  // ui
  theme:               'auto' | 'dark' | 'light';
  fontCheckDismissed:  boolean;
  /** Set true after the first-run walkthrough finishes. Reset → replay. */
  tourCompleted:       boolean;
  /** Most-recently-executed command palette IDs, newest first. Capped to 5. */
  paletteRecents:      string[];
}

const PREFS_DEFAULTS: Preferences = {
  defaultProxyPort:   8080,
  defaultCacheTtl:    0,
  defaultVerbose:     false,
  defaultProtocol:    'http',
  defaultWsModel:     'hybrid',
  defaultWsMinutes:   5,
  defaultWsMegabytes: 50,
  displayName:        'guest',
  theme:              'auto',
  fontCheckDismissed: false,
  tourCompleted:      false,
  paletteRecents:     [],
};

export function loadPrefs(): Preferences {
  const saved = readJson<Partial<Preferences>>('preferences.json', {});
  return { ...PREFS_DEFAULTS, ...saved };
}

export function savePrefs(prefs: Partial<Preferences>): void {
  // Merge with existing so callers can update a single key
  const current = readJson<Partial<Preferences>>('preferences.json', {});
  writeJson('preferences.json', { ...current, ...prefs });
}

// ─── Schema: Sessions ─────────────────────────────────────────────────────────

export type SessionType =
  | 'http-proxy'
  | 'reverse-proxy'
  | 'tunnel-http'
  | 'tunnel-tcp'
  | 'websocket';

export type SessionOutcome =
  | 'ok'
  | 'error'
  | 'budget-exhausted'
  | 'user-quit';

export interface SessionRecord {
  id:          string;
  type:        SessionType;
  label?:      string;
  url:         string;
  target:      string;
  startedAt:   number;       // epoch ms
  endedAt?:    number;
  durationMs?: number;
  outcome?:    SessionOutcome;

  // financials
  spendUsd?:   number;
  requests?:   number;
  bytesIn?:    number;
  bytesOut?:   number;

  // routing
  region?:     string;
  nodeId?:     string;
  nodeDomain?: string;
  network?:    string;       // CAIP-2
}

const MAX_SESSIONS = 100;

export function loadSessions(): SessionRecord[] {
  return readJson<SessionRecord[]>('sessions.json', []);
}

export function saveSession(session: SessionRecord): void {
  const existing = loadSessions();
  const merged   = [session, ...existing.filter(s => s.id !== session.id)];
  writeJson('sessions.json', merged.slice(0, MAX_SESSIONS));
}

// ─── Schema: Spending ─────────────────────────────────────────────────────────

export interface SpendingEntry {
  sessionId:  string;
  date:       string;       // "YYYY-MM-DD"
  type:       'proxy' | 'tunnel' | 'websocket';
  amountUsd:  number;
  network?:   string;
  txHash?:    string;
}

export interface SpendingLedger {
  allTimeUsd: number;
  entries:    SpendingEntry[];
}

export function loadSpending(): SpendingLedger {
  return readJson<SpendingLedger>('spending.json', { allTimeUsd: 0, entries: [] });
}

export function recordSpend(entry: SpendingEntry): void {
  const ledger = loadSpending();
  ledger.entries.unshift(entry);
  ledger.allTimeUsd = +(ledger.allTimeUsd + entry.amountUsd).toFixed(8);
  writeJson('spending.json', ledger);
}

// ─── Schema: Nodes cache ──────────────────────────────────────────────────────

export interface NodeInfo {
  node_id:          string;
  domain:           string;
  region:           string;
  benchmark_score?: number;
  capabilities?: {
    http_proxy?: boolean;
    caching?:    boolean;
    ipv6?:       boolean;
    ipv4?:       boolean;
    [key: string]: boolean | undefined;
  };
  status?:    string;
  ipv4?:      string;
  ipv6?:      string;
  latencyMs?: number;       // locally measured
  lastSeenAt?: number;
}

export interface NodeCache {
  fetchedAt: number;
  ttlMs:     number;
  nodes:     NodeInfo[];
}

const NODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function loadNodeCache(): NodeCache | null {
  const cache = readJson<NodeCache | null>('nodes.json', null);
  if (!cache) return null;
  if (Date.now() - cache.fetchedAt > cache.ttlMs) return null; // expired
  return cache;
}

export function saveNodeCache(nodes: NodeInfo[]): void {
  writeJson('nodes.json', { fetchedAt: Date.now(), ttlMs: NODE_TTL_MS, nodes });
}

// ─── Schema: Bookmarks ────────────────────────────────────────────────────────

export type BookmarkType =
  | 'proxy-forward'
  | 'proxy-reverse'
  | 'tunnel-http'
  | 'tunnel-tcp';

export interface Bookmark {
  id:        string;
  label:     string;
  type:      BookmarkType;
  target:    string;
  port?:     number;
  region?:   string;
  network?:  string;
  cacheTtl?: number;
  budget?:   number;
  createdAt: number;
}

export function loadBookmarks(): Bookmark[] {
  return readJson<Bookmark[]>('bookmarks.json', []);
}

export function saveBookmark(bookmark: Bookmark): void {
  const existing = loadBookmarks();
  const merged   = [bookmark, ...existing.filter(b => b.id !== bookmark.id)];
  writeJson('bookmarks.json', merged);
}

export function deleteBookmark(id: string): void {
  writeJson('bookmarks.json', loadBookmarks().filter(b => b.id !== id));
}

// ─── Migration ────────────────────────────────────────────────────────────────
// Runs once: moves ~/.consensus-config.json (old home-dir path) or
// <cwd>/.consensus-config.json into ~/.consensus/config.json.

let migrated = false;

function migrateConfig(): void {
  if (migrated) return;
  migrated = true;

  const dest = storePath('config.json');
  if (fs.existsSync(dest)) return; // already migrated

  const candidates = [
    path.join(os.homedir(), '.consensus-config.json'),
    path.join(process.cwd(), '.consensus-config.json'),
  ];

  for (const src of candidates) {
    if (!fs.existsSync(src)) continue;
    try {
      ensureDir();
      fs.copyFileSync(src, dest);
      // Leave the old file in place so nothing breaks mid-session;
      // a future release can clean it up.
    } catch { /* non-fatal */ }
    return;
  }
}
