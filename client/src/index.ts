export { ProxyClient }                                from './proxy-client.js';
export { SocketClient }                               from './socket-client.js';

// ─── Wallet & payment ─────────────────────────────────────────────────────────
export { resolveSigners }                             from './wallet.js';
export type { ResolvedSigners }                       from './wallet.js';

export { createPaymentFetch }                         from './payment-fetch.js';
export type { PaymentFetchOptions }                   from './payment-fetch.js';

// ─── Proxy worker ─────────────────────────────────────────────────────────────
export { dispatchProxy }                              from './proxy-worker.js';
export type {
  DispatchProxyOptions,
  ReverseWorkerOptions,
  ForwardWorkerOptions,
  ReverseRequestCtx,
  ReverseResponseCtx,
  ProxyWorkerHandle,
  WorkerStats,
}                                                     from './proxy-worker.js';
