import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

const DEFAULT_POOL_PATH =
  process.env.IP_POOL_PATH ?? path.resolve(process.cwd(), 'ip-pool.json');
const DEFAULT_HISTORY_PATH =
  process.env.IP_POOL_HISTORY_PATH ?? path.resolve(process.cwd(), 'ip-pool-history.json');
const DEFAULT_MAX_RENTERS = 10;
const STATIC_CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_RENTAL_TTL_MS = 60 * 60 * 1000;
export const EVICTION_STRIKE_THRESHOLD = 3;


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
  /**
   * Number of consecutive observation cycles where the node's heartbeat was
   * stale. Resets to 0 on any healthy observation. Eviction fires once this
   * reaches EVICTION_STRIKE_THRESHOLD.
   */
  consecutiveMisses: number;
}

export interface PoolStore {
  /** Entries keyed by IP address string. */
  entries: Record<string, PoolEntry>;
}

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

export interface StrikeIpOptions {
  poolPath?: string;
  persist?: boolean;
  /** Override the threshold at which a strike triggers eviction (default: EVICTION_STRIKE_THRESHOLD). */
  evictionThreshold?: number;
}

export interface PoolStats {
  /** Active entries (not removed). */
  total: number;
  available: number;
  atCapacity: number;
  removed: number;
  activeRentals: number;
}

type HistoryStore = Record<string, DeviceIpObservation[]>;

const POOL_READ_CACHE_TTL = 5_000;

interface ReadCache<T> { value: T; path: string; at: number; }
let _poolCache:    ReadCache<PoolStore>    | null = null;
let _historyCache: ReadCache<HistoryStore> | null = null;

function readHistoryStore(historyPath: string): HistoryStore {
  if (_historyCache && _historyCache.path === historyPath && Date.now() - _historyCache.at < POOL_READ_CACHE_TTL) {
    return _historyCache.value;
  }
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const value = JSON.parse(raw) as HistoryStore;
    _historyCache = { value, path: historyPath, at: Date.now() };
    return value;
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
  _historyCache = { value: store, path: historyPath, at: Date.now() };
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fsp.writeFile(historyPath, JSON.stringify(store, null, 2), 'utf8').catch((err) =>
    console.error('[Pool] savePoolHistory write failed:', err.message),
  );
  return normalized;
}

export function loadPool(poolPath = DEFAULT_POOL_PATH): PoolStore {
  if (_poolCache && _poolCache.path === poolPath && Date.now() - _poolCache.at < POOL_READ_CACHE_TTL) {
    return _poolCache.value;
  }
  try {
    const raw    = fs.readFileSync(poolPath, 'utf8');
    const parsed = JSON.parse(raw) as PoolStore;
    const value  = parsed ?? { entries: {} };
    _poolCache = { value, path: poolPath, at: Date.now() };
    return value;
  } catch {
    return { entries: {} };
  }
}

export function savePool(store: PoolStore, poolPath = DEFAULT_POOL_PATH): void {
  _poolCache = { value: store, path: poolPath, at: Date.now() };
  fs.mkdirSync(path.dirname(poolPath), { recursive: true });
  fsp.writeFile(poolPath, JSON.stringify(store, null, 2), 'utf8').catch((err) =>
    console.error('[Pool] savePool write failed:', err.message),
  );
}

/** Drop expired rentals from an entry in-place and return it. */
function purgeExpiredRentals(entry: PoolEntry): PoolEntry {
  const now = Date.now();
  entry.rentals = entry.rentals.filter((r) => r.expiresAt > now);
  return entry;
}

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
        consecutiveMisses: 0,
      };
      deposited.push(ip);
    } else {
      const existing = store.entries[ip]!;
      if (existing.status === 'removed') {
        existing.clue = clue;
        existing.depositedAt = now;
        existing.consecutiveMisses = 0;
        existing.status = 'available';
        deposited.push(ip);
      } else {
        existing.clue = clue;
        existing.consecutiveMisses = 0;
        existing.status = deriveStatus(existing);
      }
    }
  }

  if (options.persist !== false) savePool(store, options.poolPath);
  return { deposited, rejected: false, clue, store };
}

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
  entry.consecutiveMisses = 0;
  entry.status = 'removed';

  if (options.persist !== false) savePool(store, options.poolPath);
  return { removed: true, evicted, store };
}

export function strikeIp(
  ip: string,
  nodeId: string,
  options: StrikeIpOptions = {},
): { shouldEvict: boolean; strikes: number; store: PoolStore } {
  const threshold = options.evictionThreshold ?? EVICTION_STRIKE_THRESHOLD;
  const store = loadPool(options.poolPath);
  const entry = store.entries[ip];

  if (!entry || entry.nodeId !== nodeId || entry.status === 'removed') {
    return { shouldEvict: false, strikes: 0, store };
  }

  entry.consecutiveMisses = (entry.consecutiveMisses ?? 0) + 1;
  const shouldEvict = entry.consecutiveMisses >= threshold;

  if (options.persist !== false) savePool(store, options.poolPath);
  return { shouldEvict, strikes: entry.consecutiveMisses, store };
}

export function clearStrikes(
  ip: string,
  nodeId: string,
  options: Pick<StrikeIpOptions, 'poolPath' | 'persist'> = {},
): void {
  const store = loadPool(options.poolPath);
  const entry = store.entries[ip];

  if (!entry || entry.nodeId !== nodeId || (entry.consecutiveMisses ?? 0) === 0) return;

  entry.consecutiveMisses = 0;
  if (options.persist !== false) savePool(store, options.poolPath);
}


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
  const stats: PoolStats = { total: 0, available: 0, atCapacity: 0, removed: 0, activeRentals: 0 };
  for (const e of entries) {
    stats.activeRentals += e.rentals.length;
    if (e.status === 'available')      { stats.total++; stats.available++; }
    else if (e.status === 'at_capacity') { stats.total++; stats.atCapacity++; }
    else if (e.status === 'removed')     { stats.removed++; }
  }
  return stats;
}

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
