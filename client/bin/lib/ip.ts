/**
 * ip.ts — node listing and IP leasing logic shared by CLI commands and TUI screens
 */

import { saveConfig, ConsensusConfig } from './config.ts';

export interface NodeInfo {
  node_id: string;
  domain: string;
  region: string;
  benchmark_score?: number;
  capabilities?: {
    http_proxy?: boolean;
    caching?: boolean;
    ipv6?: boolean;
    ipv4?: boolean;
    [key: string]: boolean | undefined;
  };
  status?: string;
  ipv4?: string;
  ipv6?: string;
}

/**
 * Lists available nodes on the consensus network.
 * Calls GET /nodes on the x402 proxy URL.
 */
export async function listNodes(opts: {
  config: ConsensusConfig;
  region?: string;
}): Promise<NodeInfo[]> {
  const baseUrl = (
    opts.config.x402_proxy_url ||
    process.env.X402_PROXY_URL ||
    'https://consensus.proxy.canister.software:3001'
  ).replace(/\/$/, '');

  const apiKey = opts.config.api_key ?? '';

  let url = `${baseUrl}/nodes`;
  if (opts.region) url += `?region=${encodeURIComponent(opts.region)}`;

  const res = await fetch(url, {
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to list nodes: ${res.status}${body ? ` — ${body}` : ''}`);
  }

  const data = (await res.json()) as unknown;

  // Handle { nodes: [...] }, { data: [...] }, or plain array
  if (Array.isArray(data)) return data as NodeInfo[];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.nodes)) return obj.nodes as NodeInfo[];
  if (Array.isArray(obj.data))  return obj.data  as NodeInfo[];
  return [];
}

/**
 * Leases a node by domain or node_id.
 * Saves leased_node to the config file. All subsequent proxy/tunnel/ws
 * traffic will be pinned to this node via node_domain routing.
 */
export function leaseNode(opts: {
  config: ConsensusConfig;
  nodeIdOrDomain: string;
  nodes?: NodeInfo[];
}): void {
  let domain = opts.nodeIdOrDomain;
  let node_id: string | undefined;
  let region: string | undefined;

  // If a node list is available, resolve the domain from node_id (or confirm domain)
  if (opts.nodes?.length) {
    const match = opts.nodes.find(
      (n) => n.node_id === opts.nodeIdOrDomain || n.domain === opts.nodeIdOrDomain
    );
    if (match) {
      domain  = match.domain;
      node_id = match.node_id;
      region  = match.region;
    }
  }

  saveConfig({
    ...opts.config,
    leased_node: {
      domain,
      node_id,
      region,
      leased_at: new Date().toISOString(),
    },
  });
}

/**
 * Clears the leased node from the config.
 * Traffic will return to automatic node selection.
 */
export function releaseNode(config: ConsensusConfig): void {
  saveConfig({ ...config, leased_node: null });
}

/** Format a capabilities object into a short readable string */
export function fmtCapabilities(caps?: NodeInfo['capabilities']): string {
  if (!caps) return '—';
  const flags = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace('_proxy', '').replace('_', '-'));
  return flags.join(', ') || '—';
}
