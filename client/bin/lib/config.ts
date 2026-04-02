import fs from 'fs';
import path from 'path';

export interface LeasedNode {
  domain: string;
  node_id?: string;
  region?: string;
  leased_at: string;
}

export interface ConsensusConfig {
  wallet_name?: string;
  addresses?: { evm: string; solana: string };
  api_key?: string;
  x402_proxy_url?: string;
  setup_date?: string;
  version?: string;
  leased_node?: LeasedNode | null;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Resolves config file path — same cwd convention as the main ConsensusSDK class. */
function configPath(): string {
  return path.join(process.cwd(), '.consensus-config.json');
}

export function loadConfig(): ConsensusConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return JSON.parse(raw) as ConsensusConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: ConsensusConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

/**
 * Returns node routing options for ProxyClient / SocketClient.
 * A leased node always takes priority over any CLI flags.
 */
export function getNodeOptions(
  config: ConsensusConfig,
  flags: { region?: string; nodeDomain?: string; nodeExclude?: string } = {}
): { node_region?: string; node_domain?: string; node_exclude?: string } {
  if (config.leased_node?.domain) {
    return { node_domain: config.leased_node.domain };
  }
  return {
    node_region: flags.region,
    node_domain: flags.nodeDomain,
    node_exclude: flags.nodeExclude,
  };
}

/**
 * Creates a fetch function that attaches the API key header on every request.
 * Used as the `fetchWithPayment` argument for ProxyClient and SocketClient.
 */
export function makeFetchWithPayment(apiKey: string): FetchFn {
  return (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (apiKey) headers.set('X-API-Key', apiKey);
    return fetch(input, { ...init, headers });
  };
}

/** Pretty-print a USD amount to 6 decimal places. */
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

/** Pretty-print bytes to a human-readable string. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Pretty-print uptime in seconds to h/m/s string. */
export function fmtUptime(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
