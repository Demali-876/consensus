/**
 * websockets.ts — core WebSocket logic shared by CLI commands and TUI screens
 */

import { SocketClient } from '../../src/socket-client.ts';
import { getNodeOptions, ConsensusConfig } from './config.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type WsModel = 'hybrid' | 'time' | 'data';

export interface WsTokenResult {
  token: string;
  connect_url: string;
  expires_in: number;
}

export interface WsSession {
  send: (data: string) => void;
  close: () => void;
}

/**
 * Request a WebSocket session token from the consensus network.
 */
export async function getWsToken(opts: {
  fetchFn: FetchFn;
  config: ConsensusConfig;
  model?: WsModel;
  minutes?: number;
  megabytes?: number;
  region?: string;
}): Promise<WsTokenResult> {
  const nodeOpts = getNodeOptions(opts.config, { region: opts.region });

  const client = SocketClient(opts.fetchFn as Parameters<typeof SocketClient>[0], {
    defaults: {
      nodeRegion: nodeOpts.node_region,
      nodeDomain: nodeOpts.node_domain,
    },
  });

  return client.requestToken({
    model: opts.model ?? 'hybrid',
    minutes: opts.minutes ?? 5,
    megabytes: opts.megabytes ?? 50,
  });
}

/**
 * Open a WebSocket session through the consensus network.
 * Returns a handle to send messages and close the session.
 */
export async function connectWs(opts: {
  fetchFn: FetchFn;
  config: ConsensusConfig;
  model?: WsModel;
  minutes?: number;
  megabytes?: number;
  region?: string;
  onMessage?: (data: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (e: unknown) => void;
}): Promise<WsSession> {
  const nodeOpts = getNodeOptions(opts.config, { region: opts.region });

  const client = SocketClient(opts.fetchFn as Parameters<typeof SocketClient>[0], {
    defaults: {
      nodeRegion: nodeOpts.node_region,
      nodeDomain: nodeOpts.node_domain,
    },
  });

  const auth = await client.requestToken({
    model: opts.model ?? 'hybrid',
    minutes: opts.minutes ?? 5,
    megabytes: opts.megabytes ?? 50,
  });

  const session = await client.connect(auth, {
    onOpen: opts.onOpen,
    onMessage: (data: unknown) => opts.onMessage?.(String(data)),
    onClose: opts.onClose,
    onError: opts.onError,
  });

  return {
    send: (data: string) => session.send(data),
    close: () => session.close(),
  };
}

/** Pricing summary for a given model + minutes + megabytes */
export function quoteWs(model: WsModel, minutes: number, megabytes: number): number {
  const rates: Record<WsModel, { min: number; mb: number }> = {
    hybrid: { min: 0.0005, mb: 0.0001 },
    time:   { min: 0.001,  mb: 0 },
    data:   { min: 0,      mb: 0.00012 },
  };
  const r = rates[model];
  return r.min * minutes + r.mb * megabytes;
}
