import crypto from 'node:crypto';
import NodeStore from '../../data/node_store.js';
import { observeRemoteIp, resolvePublicIps, type DeviceIpClue, type DeviceIpObservation } from './detector.ts';
import {
  loadPoolHistory,
  savePoolHistory,
  depositIp,
  removeIp,
  strikeIp,
  clearStrikes,
  EVICTION_STRIKE_THRESHOLD,
} from './pool.ts';

export const SERVER_NODE_ID = 'server';
const HEARTBEAT_TIMEOUT_S = 2 * 60 * 60;

export interface ObserveNodeResult {
  nodeId: string;
  deposited: string[];
  rejected: boolean;
  clue: DeviceIpClue;
  observation: DeviceIpObservation;
}

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

export async function observeAllNodes(): Promise<ObserveNodeResult[]> {
  const nodes = NodeStore.listNodes().filter(
    (n: any) => n.status === 'active' && n.id !== SERVER_NODE_ID,
  );

  if (nodes.length === 0) {
    console.log('[Observer] No nodes to observe (server is the only node) — skipping');
    return [];
  }

  const now = Math.floor(Date.now() / 1000);
  const results: ObserveNodeResult[] = [];

  for (const node of nodes) {
    const ipv4 = (node.capabilities?.ipv4 as string | null | undefined) ?? null;
    const ipv6 = (node.capabilities?.ipv6 as string | null | undefined) ?? null;

    if (!ipv4 && !ipv6) continue;

    const heartbeatAt = node.heartbeat?.at as number | null | undefined;
    if (heartbeatAt != null && now - heartbeatAt > HEARTBEAT_TIMEOUT_S) {
      const ips = ([ipv4, ipv6] as Array<string | null>).filter((ip): ip is string => ip !== null);
      let evict = false;

      for (const ip of ips) {
        const { shouldEvict, strikes } = strikeIp(ip, node.id);
        console.log(
          `[Observer] Node ${node.id} missed heartbeat — strike ${strikes}/${EVICTION_STRIKE_THRESHOLD} on ${ip}`,
        );
        if (shouldEvict) evict = true;
      }

      if (evict) {
        if (ipv4) removeIp(ipv4, node.id);
        if (ipv6) removeIp(ipv6, node.id);
        console.log(`[Observer] Node ${node.id} reached eviction threshold — removed from pool`);
      }

      continue;
    }

    if (ipv4) clearStrikes(ipv4, node.id);
    if (ipv6) clearStrikes(ipv6, node.id);

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

export async function upsertServerNode(): Promise<void> {
  try {
    const publicIps = await resolvePublicIps();

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

export function startObservationScheduler(intervalMs = 12 * 60 * 60 * 1000): ReturnType<typeof setInterval> {
  console.log(`[Observer] Scheduler started — running every 12 h (2x/day for 7-day window)`);

  void observeAllNodes();
  return setInterval(() => void observeAllNodes(), intervalMs);
}
