import crypto from 'node:crypto';
import NodeStore from '../../data/node_store.js';
import { observeRemoteIp, resolvePublicIps, type DeviceIpClue, type DeviceIpObservation } from './detector.ts';
import { loadPoolHistory, savePoolHistory, depositIp, removeIp } from './pool.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Node ID reserved for the main server — never observed by the scheduler. */
export const SERVER_NODE_ID = 'server';

/**
 * How long (in seconds) a node may go without a heartbeat before its IPs
 * are evicted from the pool. Matches the 5-min heartbeat interval with a
 * 3x grace multiplier.
 */
const HEARTBEAT_TIMEOUT_S = 15 * 60;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ObserveNodeResult {
  nodeId: string;
  deposited: string[];
  rejected: boolean;
  clue: DeviceIpClue;
  observation: DeviceIpObservation;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Observe a single remote node.
 *
 * Performs a reverse DNS lookup on the node's known IPs, appends a new
 * DeviceIpObservation to that node's history, then attempts to deposit the
 * IPs into the rental pool if the static-confidence threshold is met.
 */
export async function observeNode(
  nodeId: string,
  ipv4: string | null,
  ipv6: string | null,
): Promise<ObserveNodeResult> {
  const observation = await observeRemoteIp({ ipv4: ipv4 ?? null, ipv6: ipv6 ?? null });

  const history = loadPoolHistory(nodeId);
  savePoolHistory(nodeId, [...history, observation]);

  const { deposited, rejected, clue } = depositIp(nodeId, observation, history);

  return { nodeId, deposited, rejected, clue, observation };
}

/**
 * Observe every active node the server knows about.
 *
 * Nodes that have gone silent past the heartbeat timeout have their IPs
 * evicted from the pool immediately and are skipped for observation.
 *
 * The main server node (SERVER_NODE_ID) is always skipped — it is upserted
 * directly without going through the observation pipeline.
 */
export async function observeAllNodes(): Promise<ObserveNodeResult[]> {
  const nodes = NodeStore.listNodes().filter(
    (n: any) => n.status === 'active' && n.id !== SERVER_NODE_ID,
  );

  if (nodes.length === 0) {
    console.log('[Observer] No nodes to observe (server is the only node) — skipping');
    return [];
  }

  const now = Math.floor(Date.now() / 1000); // heartbeat.at is stored in seconds
  const results: ObserveNodeResult[] = [];

  for (const node of nodes) {
    const ipv4 = (node.capabilities?.ipv4 as string | null | undefined) ?? null;
    const ipv6 = (node.capabilities?.ipv6 as string | null | undefined) ?? null;

    if (!ipv4 && !ipv6) continue;

    // Evict stale nodes — only if a heartbeat was ever recorded
    const heartbeatAt = node.heartbeat?.at as number | null | undefined;
    if (heartbeatAt != null && now - heartbeatAt > HEARTBEAT_TIMEOUT_S) {
      if (ipv4) removeIp(ipv4, node.id);
      if (ipv6) removeIp(ipv6, node.id);
      console.log(`[Observer] Node ${node.id} is stale — evicted from pool`);
      continue;
    }

    try {
      const result = await observeNode(node.id, ipv4, ipv6);
      results.push(result);

      if (result.deposited.length > 0) {
        console.log(
          `[Observer] Node ${node.id} promoted to pool: ${result.deposited.join(', ')}`,
        );
      }
    } catch (err) {
      console.error(`[Observer] Failed to observe node ${node.id}:`, err);
    }
  }

  return results;
}

// ─── Server self-registration ─────────────────────────────────────────────────

/**
 * Upsert the main server into NodeStore as a first-class node.
 *
 * The server skips payment, benchmarking, and the observation pipeline —
 * its IPs are resolved directly and it is trusted by definition.
 * Called once on boot, after the HTTP server is listening.
 */
export async function upsertServerNode(): Promise<void> {
  try {
    const publicIps = await resolvePublicIps();

    // Generate a stable-enough ed25519 public key for the schema's NOT NULL
    // constraint. The server is the trusted root so this key isn't used for
    // external verification, but having a real key keeps the data consistent.
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkeyBuffer = publicKey.export({ format: 'der', type: 'spki' });

    NodeStore.upsertNode({
      id:             SERVER_NODE_ID,
      pubkey_ed25519: pubkeyBuffer,
      region:         process.env.SERVER_REGION  ?? 'unknown',
      contact:        process.env.SERVER_CONTACT ?? 'unknown',
      capabilities: {
        forward_proxy: true,
        reverse_proxy: true,
        websockets:    true,
        tunnels:       true,
        ip_leasing:    true,
        benchmark_score: 100,
        ipv4: publicIps.ipv4,
        ipv6: publicIps.ipv6,
        port: Number(process.env.PORT ?? 8080),
      },
      evm_address:    process.env.EVM_PAY_TO    ?? null,
      solana_address: process.env.SOLANA_PAY_TO ?? null,
      icp_address:    process.env.ICP_PAY_TO    ?? null,
      status:         'active',
    });

    console.log(`[Observer] Server node upserted — ipv4=${publicIps.ipv4} ipv6=${publicIps.ipv6}`);
  } catch (err) {
    console.error('[Observer] Failed to upsert server node:', err);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Start the observation loop.
 *
 * Fires immediately on boot, then twice a day (every 12 hours) for the
 * 7-day window the classifier needs to reach static confidence. That gives
 * each node up to 14 observations before promotion is possible.
 *
 * Returns the interval handle so the caller can clear it on shutdown.
 */
export function startObservationScheduler(intervalMs = 12 * 60 * 60 * 1000): ReturnType<typeof setInterval> {
  console.log(`[Observer] Scheduler started — running every 12 h (2x/day for 7-day window)`);

  void observeAllNodes();
  return setInterval(() => void observeAllNodes(), intervalMs);
}
