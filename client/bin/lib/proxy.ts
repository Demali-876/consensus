/**
 * proxy.ts — core proxy logic shared by CLI commands and TUI screens
 */

import http from 'http';
import net from 'net';
import { getNodeOptions, ConsensusConfig } from './config.ts';
import { ProxyClient } from '../../src/proxy-client.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProxyStats {
  requests: number;
  spend: number;
  bytesSent: number;
  bytesRecv: number;
  startedAt: number;
}

export interface ProxyFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  meta: unknown;
}

/**
 * One-shot proxy request through the consensus network.
 */
export async function proxyFetch(opts: {
  fetchFn: FetchFn;
  config: ConsensusConfig;
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  region?: string;
  cacheTtl?: number;
  verbose?: boolean;
}): Promise<ProxyFetchResult> {
  const nodeOpts = getNodeOptions(opts.config, { region: opts.region });

  // ProxyClient expects (fetchWithPayment, options) → middleware with .request()
  const client = ProxyClient(opts.fetchFn as Parameters<typeof ProxyClient>[0], {
    strategy: 'manual',
    cache_ttl: opts.cacheTtl,
    verbose: opts.verbose,
    node_region: nodeOpts.node_region,
    node_domain: nodeOpts.node_domain,
  });

  return client.request({
    target_url: opts.targetUrl,
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
  });
}

/**
 * Starts a local HTTP proxy daemon that routes outbound traffic through the
 * consensus network. Handles CONNECT (HTTPS) via pass-through TCP tunnel.
 * Returns a handle to stop the server.
 */
export async function startProxyDaemon(opts: {
  fetchFn: FetchFn;
  config: ConsensusConfig;
  port?: number;
  budget?: number;
  region?: string;
  cacheTtl?: number;
  onStats?: (stats: ProxyStats) => void;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? 8080;
  const nodeOpts = getNodeOptions(opts.config, { region: opts.region });

  const stats: ProxyStats = {
    requests: 0,
    spend: 0,
    bytesSent: 0,
    bytesRecv: 0,
    startedAt: Date.now(),
  };

  const client = ProxyClient(opts.fetchFn as Parameters<typeof ProxyClient>[0], {
    strategy: 'manual',
    cache_ttl: opts.cacheTtl,
    limit_usd: opts.budget,
    node_region: nodeOpts.node_region,
    node_domain: nodeOpts.node_domain,
    on_limit_reached: () => {
      opts.onStats?.(stats);
    },
  });

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    try {
      const rawHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') rawHeaders[k] = v;
      }

      const result = await client.request({
        target_url: req.url || '/',
        method: req.method || 'GET',
        headers: rawHeaders,
      });

      // Forward response headers
      for (const [k, v] of Object.entries(result.headers ?? {})) {
        if (typeof v === 'string') res.setHeader(k, v);
      }
      res.writeHead(result.status);

      const body =
        typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      stats.bytesSent += body.length;
      res.end(body);

      const budget = client.getBudget();
      stats.spend = budget.spent_usd;
      opts.onStats?.(stats);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Proxy error';
      res.writeHead(502);
      res.end(msg);
    }
  });

  // HTTPS CONNECT tunneling — pass-through without payment
  server.on('connect', (req, clientSocket, head) => {
    stats.requests++;
    const [hostname, portStr] = (req.url ?? '').split(':');
    const targetPort = parseInt(portStr ?? '443', 10);

    const serverSocket = net.createConnection(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve());
    server.on('error', reject);
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
