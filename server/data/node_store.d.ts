export const db: any;

export const NodeStore: {
  upsertNode(input: any): any;
  getNode(id: string): any;
  listNodes(): any[];
  setDomain(id: string, domain: string, tls_mode: string | null): any;
  heartbeat(
    id: string,
    opts?: { rps?: number | null; p95_ms?: number | null; version?: string | null }
  ): any;
  createJoinRequest(input: { pubkey: any; alg: string; ttlSeconds?: number }): any;
  getJoin(id: string): any;
  consumeJoin(id: string): any;
};

declare const _default: typeof NodeStore;
export default _default;
