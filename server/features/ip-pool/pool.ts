import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDeviceIps,
  dedupeAndTrimHistory,
  resolveCurrentObservation,
  type DeviceIpClue,
  type DeviceIpObservation,
  type IpFamily,
} from './detector.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_POOL_PATH =
  process.env.IP_POOL_PATH ?? path.resolve(process.cwd(), 'ip-pool.json');

const DEFAULT_HISTORY_PATH =
  process.env.IP_POOL_HISTORY_PATH ?? path.resolve(process.cwd(), 'ip-pool-history.json');

/** How many users may hold a rental on the same IP at once. */
const DEFAULT_MAX_RENTERS = 10;

/** staticConfidence must be at or above this before an IP enters the pool. */
const STATIC_CONFIDENCE_THRESHOLD = 0.9;

/** Default rental duration when no TTL is supplied (1 hour). */
const DEFAULT_RENTAL_TTL_MS = 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PoolEntryStatus = 'available' | 'at_capacity' | 'removed';

/** One active rental slot on a shared IP. */
export interface RentalRecord {
  userId: string;
  rentedAt: number;
  expiresAt: number;
}

/** A single IP address living in the pool. */
export interface PoolEntry {
  ip: string;
  family: IpFamily;
  nodeId: string;
  clue: DeviceIpClue;
  status: PoolEntryStatus;
  depositedAt: number;
  /** Hard cap on concurrent renters for this IP. */
  maxRenters: number;
  /** All currently-active (non-expired) rentals. */
  rentals: RentalRecord[];
}

export interface PoolStore {
  /** Entries keyed by IP address string. */
  entries: Record<string, PoolEntry>;
}

// ─── Option bags ──────────────────────────────────────────────────────────────

export interface DepositIpOptions {
  /** Override the default max-renters cap for this IP. */
  maxRenters?: number;
  /** Path to the pool JSON file. */
  poolPath?: string;
  /** Write changes back to disk (default: true). */
  persist?: boolean;
  /** Minimum staticConfidence required to enter the pool (default: 0.9). */
  confidenceThreshold?: number;
}

export interface DetectAndDepositOptions extends DepositIpOptions {
  reverseDns?: boolean;
  historyPath?: string;
}

export interface RentIpOptions {
  /** Request a specific IP; omit for auto-assignment. */
  ip?: string;
  /** Prefer IPv4 or IPv6 during auto-assignment. */
  preferFamily?: IpFamily;
  /** Rental duration in ms (default: 1 hour). */
  ttlMs?: number;
  poolPath?: string;
  persist?: boolean;
}

export interface ReleaseIpOptions {
  poolPath?: string;
  persist?: boolean;
}

export interface RemoveIpOptions {
  poolPath?: string;
  persist?: boolean;
}

export interface PoolStats {
  /** Active entries (not removed). */
  total: number;
  available: number;
  atCapacity: number;
  removed: number;
  activeRentals: number;
}

// ─── Observation-history persistence (per-node, keyed by nodeId) ─────────────

type HistoryStore = Record<string, DeviceIpObservation[]>;

function readHistoryStore(historyPath: string): HistoryStore {
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    return JSON.parse(raw) as HistoryStore;
  } catch {
    return {};
  }
}

export function loadPoolHistory(
  nodeId: string,
  historyPath = DEFAULT_HISTORY_PATH,
): DeviceIpObservation[] {
  const store = readHistoryStore(historyPath);
  return dedupeAndTrimHistory(store[nodeId] ?? []);
}

export function savePoolHistory(
  nodeId: string,
  observations: DeviceIpObservation[],
  historyPath = DEFAULT_HISTORY_PATH,
): DeviceIpObservation[] {
  const normalized = dedupeAndTrimHistory(observations);
  const store = readHistoryStore(historyPath);
  store[nodeId] = normalized;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(store, null, 2), 'utf8');
  return normalized;
}

// ─── Pool-store persistence ───────────────────────────────────────────────────

export function loadPool(poolPath = DEFAULT_POOL_PATH): PoolStore {
  try {
    const raw = fs.readFileSync(poolPath, 'utf8');
    const parsed = JSON.parse(raw) as PoolStore;
    return parsed ?? { entries: {} };
  } catch {
    return { entries: {} };
  }
}

export function savePool(store: PoolStore, poolPath = DEFAULT_POOL_PATH): void {
  fs.mkdirSync(path.dirname(poolPath), { recursive: true });
  fs.writeFileSync(poolPath, JSON.stringify(store, null, 2), 'utf8');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Drop expired rentals from an entry in-place and return it. */
function purgeExpiredRentals(entry: PoolEntry): PoolEntry {
  const now = Date.now();
  entry.rentals = entry.rentals.filter((r) => r.expiresAt > now);
  return entry;
}

/**
 * Re-derive `status` from the live rental count.
 * A 'removed' entry stays removed regardless.
 */
function deriveStatus(entry: PoolEntry): PoolEntryStatus {
  if (entry.status === 'removed') return 'removed';
  return entry.rentals.length >= entry.maxRenters ? 'at_capacity' : 'available';
}

/** Purge expired rentals across every entry and sync derived statuses. */
function refreshStore(store: PoolStore): void {
  for (const entry of Object.values(store.entries)) {
    purgeExpiredRentals(entry);
    entry.status = deriveStatus(entry);
  }
}

// ─── Deposit ──────────────────────────────────────────────────────────────────

/**
 * Deposit a node's IPs into the rental pool.
 *
 * The observation is classified using the provided history. If the result
 * reaches `kind: 'static'` with `staticConfidence >= threshold`, both the
 * IPv4 and IPv6 addresses (whichever are present) are added as `available`
 * pool entries. Re-depositing an existing IP refreshes its classification
 * clue without touching active rentals.
 *
 * If the classification does NOT meet the threshold nothing is written.
 */
export function depositIp(
  nodeId: string,
  observation: DeviceIpObservation,
  history: DeviceIpObservation[] = [],
  options: DepositIpOptions = {},
): { deposited: string[]; rejected: boolean; clue: DeviceIpClue; store: PoolStore } {
  const threshold = options.confidenceThreshold ?? STATIC_CONFIDENCE_THRESHOLD;
  const clue = classifyDeviceIps({ current: observation, history });

  if (clue.kind !== 'static' || clue.staticConfidence < threshold) {
    const store = options.persist !== false ? loadPool(options.poolPath) : { entries: {} };
    return { deposited: [], rejected: true, clue, store };
  }

  const store = options.persist !== false ? loadPool(options.poolPath) : { entries: {} };
  refreshStore(store);

  const deposited: string[] = [];
  const now = Date.now();

  const candidates: Array<[IpFamily, string | null]> = [
    [4, clue.publicIps.ipv4],
    [6, clue.publicIps.ipv6],
  ];

  for (const [family, ip] of candidates) {
    if (!ip) continue;

    if (!store.entries[ip]) {
      // Brand-new entry
      store.entries[ip] = {
        ip,
        family,
        nodeId,
        clue,
        status: 'available',
        depositedAt: now,
        maxRenters: options.maxRenters ?? DEFAULT_MAX_RENTERS,
        rentals: [],
      };
      deposited.push(ip);
    } else {
      // Already present — refresh classification, leave rentals intact
      store.entries[ip]!.clue = clue;
      store.entries[ip]!.status = deriveStatus(store.entries[ip]!);
    }
  }

  if (options.persist !== false) savePool(store, options.poolPath);
  return { deposited, rejected: false, clue, store };
}

// ─── Rent ─────────────────────────────────────────────────────────────────────

/**
 * Rent an IP from the pool.
 *
 * Multiple users may share the same IP address simultaneously up to
 * `maxRenters`. When all slots are taken the IP is marked `at_capacity` and
 * skipped during auto-assignment.
 *
 * Auto-assignment picks the `available` entry with the fewest active rentals
 * (least-loaded). Pass `preferFamily` to bias toward IPv4 or IPv6.
 *
 * Returns `null` when no suitable IP is currently available.
 */
export function rentIp(
  userId: string,
  options: RentIpOptions = {},
): { rental: RentalRecord; entry: PoolEntry; store: PoolStore } | null {
  const store = loadPool(options.poolPath);
  refreshStore(store);

  const ttl = options.ttlMs ?? DEFAULT_RENTAL_TTL_MS;
  const now = Date.now();

  let target: PoolEntry | undefined;

  if (options.ip) {
    // Caller requested a specific IP
    const entry = store.entries[options.ip];
    if (entry?.status === 'available') target = entry;
  } else {
    // Auto-assign — sort available entries by current load (ascending)
    const available = Object.values(store.entries).filter(
      (e) => e.status === 'available',
    );

    const preferred = options.preferFamily
      ? available.filter((e) => e.family === options.preferFamily)
      : available;

    const sorted = (preferred.length > 0 ? preferred : available).sort(
      (a, b) => a.rentals.length - b.rentals.length,
    );

    target = sorted[0];
  }

  if (!target) return null;

  const rental: RentalRecord = {
    userId,
    rentedAt: now,
    expiresAt: now + ttl,
  };

  target.rentals.push(rental);
  target.status = deriveStatus(target);

  if (options.persist !== false) savePool(store, options.poolPath);
  return { rental, entry: target, store };
}

// ─── Release ──────────────────────────────────────────────────────────────────

/**
 * Release a user's rental on a specific IP, freeing a slot for someone else.
 * All rentals belonging to `userId` on that IP are removed (normally there
 * is only one, but this handles duplicates defensively).
 */
export function releaseIp(
  ip: string,
  userId: string,
  options: ReleaseIpOptions = {},
): { released: boolean; freedSlots: number; store: PoolStore } {
  const store = loadPool(options.poolPath);
  const entry = store.entries[ip];

  if (!entry) return { released: false, freedSlots: 0, store };

  purgeExpiredRentals(entry);
  const before = entry.rentals.length;
  entry.rentals = entry.rentals.filter((r) => r.userId !== userId);
  const freedSlots = before - entry.rentals.length;

  entry.status = deriveStatus(entry);

  if (freedSlots > 0 && options.persist !== false) savePool(store, options.poolPath);
  return { released: freedSlots > 0, freedSlots, store };
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Permanently remove an IP from the pool (e.g. node went offline or IP
 * was reclassified as dynamic). All active rentals are evicted immediately.
 *
 * Only the node that deposited the IP may remove it.
 */
export function removeIp(
  ip: string,
  nodeId: string,
  options: RemoveIpOptions = {},
): { removed: boolean; evicted: number; store: PoolStore } {
  const store = loadPool(options.poolPath);
  const entry = store.entries[ip];

  if (!entry || entry.nodeId !== nodeId) {
    return { removed: false, evicted: 0, store };
  }

  const evicted = entry.rentals.length;
  entry.rentals = [];
  entry.status = 'removed';

  if (options.persist !== false) savePool(store, options.poolPath);
  return { removed: true, evicted, store };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function listPool(
  filter?: { status?: PoolEntryStatus; nodeId?: string; family?: IpFamily },
  poolPath = DEFAULT_POOL_PATH,
): PoolEntry[] {
  const store = loadPool(poolPath);
  refreshStore(store);

  let entries = Object.values(store.entries);
  if (filter?.status !== undefined) entries = entries.filter((e) => e.status === filter.status);
  if (filter?.nodeId !== undefined) entries = entries.filter((e) => e.nodeId === filter.nodeId);
  if (filter?.family !== undefined) entries = entries.filter((e) => e.family === filter.family);

  return entries;
}

export function getPoolStats(poolPath = DEFAULT_POOL_PATH): PoolStats {
  const entries = listPool(undefined, poolPath);
  return {
    total: entries.filter((e) => e.status !== 'removed').length,
    available: entries.filter((e) => e.status === 'available').length,
    atCapacity: entries.filter((e) => e.status === 'at_capacity').length,
    removed: entries.filter((e) => e.status === 'removed').length,
    activeRentals: entries.reduce((sum, e) => sum + e.rentals.length, 0),
  };
}

// ─── High-level: detect → classify → deposit ──────────────────────────────────

/**
 * Full pipeline: run the detector, save the observation to history, then
 * attempt to deposit the IPs into the rental pool.
 *
 * Useful for nodes that call this on a schedule to keep their classification
 * evidence fresh and eventually promote themselves into the pool.
 */
export async function detectAndDepositObservation(
  nodeId: string,
  options: DetectAndDepositOptions = {},
): Promise<{
  deposited: string[];
  rejected: boolean;
  clue: DeviceIpClue;
  observation: DeviceIpObservation;
  history: DeviceIpObservation[];
}> {
  const observation = await resolveCurrentObservation({ reverseDns: options.reverseDns });
  const history = loadPoolHistory(nodeId, options.historyPath);
  const nextHistory = savePoolHistory(nodeId, [...history, observation], options.historyPath);

  const { deposited, rejected, clue, store: _store } = depositIp(nodeId, observation, history, options);

  return { deposited, rejected, clue, observation, history: nextHistory };
}

// ─── CLI entry-point ──────────────────────────────────────────────────────────

async function runCli(): Promise<void> {
  const nodeId = process.env.NODE_ID ?? 'local';
  const result = await detectAndDepositObservation(nodeId);
  console.log(JSON.stringify({ clue: result.clue, deposited: result.deposited }, null, 2));
}

const isDirectExecution =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  void runCli();
}
