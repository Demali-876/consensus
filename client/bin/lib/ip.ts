import { saveConfig, loadConfig, type ConsensusConfig } from './store.ts';
export type { NodeInfo } from './store.ts';
import { type NodeInfo, loadNodeCache, saveNodeCache }  from './store.ts';

const DEFAULT_SERVER_URL = 'https://consensus.canister.software';
const LEGACY_PROXY_URL = 'https://consensus.proxy.canister.software:3001';
const NODE_FETCH_TIMEOUT_MS = 8_000;

function nodeArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray((data as any)?.nodes)) return (data as any).nodes;
  if (Array.isArray((data as any)?.data)) return (data as any).data;
  return [];
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function baseUrl(config: ConsensusConfig): string {
  const configured = (config.x402_proxy_url || process.env.X402_PROXY_URL || '').replace(/\/$/, '');
  if (configured && configured !== LEGACY_PROXY_URL) return configured;
  return (process.env.CONSENSUS_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/$/, '');
}

function nodeFetch(url: string, apiKey: string): Promise<Response> {
  return fetch(url, {
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(NODE_FETCH_TIMEOUT_MS),
  });
}

export async function listNodes(opts: {
  config:   ConsensusConfig;
  region?:  string;
  noCache?: boolean;
}): Promise<NodeInfo[]> {
  if (!opts.noCache) {
    const cached = loadNodeCache();
    if (cached) return cached.nodes;
  }

  const proxyUrl = baseUrl(opts.config);

  const apiKey = opts.config.api_key ?? '';
  let url = `${proxyUrl}/nodes`;
  if (opts.region) url += `?region=${encodeURIComponent(opts.region)}`;

  const res = await nodeFetch(url, apiKey);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to list nodes: ${res.status}${body ? ` — ${body}` : ''}`);
  }

  const data = await res.json() as unknown;
  const rawNodes = nodeArray(data);

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

export async function listBrowserNodes(opts: {
  config: ConsensusConfig;
  region?: string;
}): Promise<NodeInfo[]> {
  const apiKey = opts.config.api_key ?? '';
  let url = `${baseUrl(opts.config)}/nodes/browser`;
  if (opts.region) url += `?region=${encodeURIComponent(opts.region)}`;

  const res = await nodeFetch(url, apiKey);

  // Rolling deployments remain compatible while the browser endpoint propagates.
  if (res.status === 404) return listNodes({ ...opts, noCache: true });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to list browser nodes: ${res.status}${body ? ` — ${body}` : ''}`);
  }

  return nodeArray(await res.json() as unknown)
    .filter((node): node is Record<string, unknown> => !!node && typeof node === 'object')
    .map((node) => ({
      ...node,
      node_id: String(node.node_id ?? node.id ?? ''),
      domain: node.domain == null ? '' : String(node.domain),
      region: String(node.region ?? ''),
      ipv4: node.ipv4 == null ? undefined : String(node.ipv4),
      ipv6: node.ipv6 == null ? undefined : String(node.ipv6),
      latencyMs: optionalNumber(node.latency_ms),
      lastSeenAt: optionalNumber(node.last_seen_at),
      activeRequests: optionalNumber(node.active_requests),
      activeSessions: optionalNumber(node.active_sessions),
      availability: node.availability == null ? undefined : String(node.availability),
      version: node.version == null ? undefined : String(node.version),
      controlTunnelConnected: node.control_tunnel_connected === true,
    })) as NodeInfo[];
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
