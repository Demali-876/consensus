import { saveConfig, loadConfig, type ConsensusConfig } from './store.ts';
export type { NodeInfo } from './store.ts';
import { type NodeInfo, loadNodeCache, saveNodeCache }  from './store.ts';

export async function listNodes(opts: {
  config:   ConsensusConfig;
  region?:  string;
  noCache?: boolean;
}): Promise<NodeInfo[]> {
  if (!opts.noCache) {
    const cached = loadNodeCache();
    if (cached) return cached.nodes;
  }

  const baseUrl = (
    opts.config.x402_proxy_url ||
    process.env.X402_PROXY_URL ||
    'https://consensus.proxy.canister.software:3001'
  ).replace(/\/$/, '');

  const apiKey = opts.config.api_key ?? '';
  let url = `${baseUrl}/nodes`;
  if (opts.region) url += `?region=${encodeURIComponent(opts.region)}`;

  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to list nodes: ${res.status}${body ? ` — ${body}` : ''}`);
  }

  const data = await res.json() as unknown;
  let rawNodes: unknown[];
  if (Array.isArray(data))                    rawNodes = data;
  else if (Array.isArray((data as any).nodes)) rawNodes = (data as any).nodes;
  else if (Array.isArray((data as any).data))  rawNodes = (data as any).data;
  else rawNodes = [];

  const nodes = rawNodes
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      ...n,
      node_id: String(n.node_id ?? n.id ?? ''),
      domain:  String(n.domain ?? ''),
      region:  String(n.region ?? ''),
    })) as NodeInfo[];

  saveNodeCache(nodes);
  return nodes;
}


export function leaseNode(opts: {
  config:         ConsensusConfig;
  nodeIdOrDomain: string;
  nodes?:         NodeInfo[];
}): void {
  let domain   = opts.nodeIdOrDomain;
  let node_id: string | undefined;
  let region:  string | undefined;

  if (opts.nodes?.length) {
    const match = opts.nodes.find(
      n => n.node_id === opts.nodeIdOrDomain || n.domain === opts.nodeIdOrDomain,
    );
    if (match) { domain = match.domain || match.node_id || opts.nodeIdOrDomain; node_id = match.node_id; region = match.region; }
  }

  if (!domain) throw new Error('Selected node does not have a leaseable domain or id');

  saveConfig({
    ...opts.config,
    leased_node: { domain, node_id, region, leased_at: new Date().toISOString() },
  });
}

/**
 * Clears the leased node. Traffic returns to automatic node selection.
 */
export function releaseNode(config: ConsensusConfig): void {
  saveConfig({ ...config, leased_node: null });
}

/** Format a capabilities object into a short readable string. */
export function fmtCapabilities(caps?: NodeInfo['capabilities']): string {
  if (!caps) return '—';
  const flags = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace('_proxy', '').replace('_', '-'));
  return flags.join(', ') || '—';
}
