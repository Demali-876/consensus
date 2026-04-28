export type { ConsensusConfig, LeasedNode } from './store.ts';
export { loadConfig, saveConfig } from './store.ts';
import type { ConsensusConfig } from './store.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function getNodeOptions(
  config: ConsensusConfig,
  flags: { region?: string; nodeDomain?: string; nodeExclude?: string } = {},
): { node_region?: string; node_domain?: string; node_exclude?: string } {
  if (config.leased_node?.domain) {
    return { node_domain: config.leased_node.domain };
  }
  return {
    node_region:  flags.region,
    node_domain:  flags.nodeDomain,
    node_exclude: flags.nodeExclude,
  };
}
export function makeFetchWithPayment(apiKey: string): FetchFn {
  return (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (apiKey) headers.set('X-API-Key', apiKey);
    return fetch(input, { ...init, headers });
  };
}
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtUptime(startedAt: number): string {
  const s   = Math.floor((Date.now() - startedAt) / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
