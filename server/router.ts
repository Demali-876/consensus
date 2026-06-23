import NodeStore from './data/node_store.js';

interface RouterStats {
  total_selections: number;
  sticky_hits: number;
  fallbacks: number;
}

/**
 * Router - Routes requests to available instances
 */
const STICKY_TTL_MS    = 10 * 60 * 1000;
const STICKY_SWEEP_MS  = 60 * 1000;
const STATS_CACHE_MS   = 1_000;
const NODE_CACHE_TTL_MS = 3_000;  // node list refreshed at most once per 3 s

// The orchestrator registers itself for routing under this id (handled in
// proxy.ts executeViaNode). It is a last-resort fallback, never an equal peer in
// load-balancing — see selectNode.
const SELF_NODE_ID = 'server';
// A downstream node is treated as "saturated" once its combined (HTTP + WS) load
// reaches this value. Only when every eligible node is saturated do we serve on
// the orchestrator itself. Tunable via NODE_SATURATION_LOAD.
const DEFAULT_SATURATION_LOAD = 100;

export default class Router {
  private activeRequests: Map<string, number>;           // nodeId → HTTP request count
  private activeSessions: Map<string, number>;           // nodeId → WebSocket session count
  private requestToNode:  Map<string, { nodeId: string; at: number }>; // dedupeKey → sticky
  private stats: RouterStats;
  private statsCache: { value: ReturnType<Router['_buildStats']>; at: number } | null = null;
  private nodeCache:  { nodes: any[]; at: number } | null = null;
  private sweepTimer: ReturnType<typeof setInterval>;
  private nodeStore:  any;
  private saturationLoad: number;

  constructor(nodeStore: any = NodeStore, options: { saturationLoad?: number } = {}) {
    this.nodeStore = nodeStore;
    const envLoad = Number(process.env.NODE_SATURATION_LOAD);
    this.saturationLoad = options.saturationLoad
      ?? (Number.isFinite(envLoad) && envLoad > 0 ? envLoad : DEFAULT_SATURATION_LOAD);

    this.activeRequests = new Map();
    this.activeSessions = new Map();
    this.requestToNode  = new Map();
    this.stats = { total_selections: 0, sticky_hits: 0, fallbacks: 0 };

    this.sweepTimer = setInterval(() => this.sweepSticky(), STICKY_SWEEP_MS);
    this.sweepTimer.unref();
  }

  private sweepSticky(): void {
    const cutoff = Date.now() - STICKY_TTL_MS;
    for (const [key, { at }] of this.requestToNode) {
      if (at < cutoff) this.requestToNode.delete(key);
    }
  }

  /**
   * Select a node for a request
   * @param dedupeKey - Unique request identifier
   * @param preferenceHeaders - User preferences (x-node-region, etc.)
   * @returns Selected node or null if none available
   */
  private getNodes(): any[] {
    const now = Date.now();
    if (this.nodeCache && (now - this.nodeCache.at) < NODE_CACHE_TTL_MS) {
      return this.nodeCache.nodes;
    }
    const nodes = this.nodeStore.listNodesForRouting();
    this.nodeCache = { nodes, at: now };
    return nodes;
  }

  selectNode(dedupeKey: string, preferenceHeaders: Record<string, string> = {}): any | null {
    this.stats.total_selections++;

    const allNodes = this.getNodes();

    // Sticky: keep a request on the node that previously served it (cache
    // locality). Honoured even if that node is now busy — we still prefer nodes.
    const sticky = this.requestToNode.get(dedupeKey);
    if (sticky) {
      const node = allNodes.find((n: any) => n.id === sticky.nodeId);
      if (node && node.status === 'active' && !isNodeUpdating(node)) {
        this.stats.sticky_hits++;
        return node;
      }
      this.requestToNode.delete(dedupeKey);
    }

    // Downstream (non-self) nodes are always preferred over the orchestrator.
    let downstream = allNodes.filter((node: any) =>
      node.id !== SELF_NODE_ID && node.status === 'active' && !isNodeUpdating(node),
    );
    downstream = this.filterByPreferences(downstream, preferenceHeaders);

    // Route everything to nodes that still have spare capacity; among those,
    // power-of-two-choices balances load. Only spill to self once every eligible
    // node is saturated.
    const available = downstream.filter((node: any) => this.load(node.id) < this.saturationLoad);
    if (available.length > 0) {
      const selectedNode = this.powerOfTwoChoices(available);
      this.requestToNode.set(dedupeKey, { nodeId: selectedNode.id, at: Date.now() });
      return selectedNode;
    }

    // No node with spare capacity (all saturated, or none eligible). Prefer the
    // orchestrator-as-node — but honour preferences: a caller that excluded
    // 'server' (x-node-exclude) must not be served by self. The self candidate
    // goes through the SAME preference filter; we deliberately do NOT make it
    // sticky, so the next miss returns to a node as soon as one frees up.
    this.stats.fallbacks++;
    const self = allNodes.find((n: any) =>
      n.id === SELF_NODE_ID && n.status === 'active' && !isNodeUpdating(n),
    );

    if (self) {
      // Self exists: serve on it unless the caller explicitly excluded it.
      if (this.filterByPreferences([self], preferenceHeaders).length > 0) {
        return self;
      }
      // Self was excluded (x-node-exclude: server) — honour that by overflowing
      // onto a (saturated) downstream node if one exists, rather than violating
      // the exclusion; null only when there is nothing left to route to.
      if (downstream.length > 0) {
        const overflowNode = this.powerOfTwoChoices(downstream);
        this.requestToNode.set(dedupeKey, { nodeId: overflowNode.id, at: Date.now() });
        return overflowNode;
      }
      return null;
    }

    // Self row is merely ABSENT (e.g. before upsertServerNode() completes, or if
    // it failed) — not excluded. Preserve the documented fallback: return null so
    // the caller serves locally, instead of pushing normal traffic onto an
    // already-saturated node.
    return null;
  }

  /** Combined HTTP + WS load the orchestrator is currently tracking for a node. */
  private load(nodeId: string): number {
    return (this.activeRequests.get(nodeId) || 0) + (this.activeSessions.get(nodeId) || 0);
  }
  /**
   * Filter nodes by user preferences
   */
  private filterByPreferences(nodes: any[], headers: Record<string, string>): any[] {
    const prefs = this.parsePreferences(headers);

    return nodes.filter((node) => {
      if (prefs.exclude?.includes(node.id)) {
        return false;
      }
      if (prefs.regions && prefs.regions.length > 0) {
        const matchesRegion = prefs.regions.some((r) =>
          node.region?.toLowerCase().includes(r.toLowerCase())
        );
        if (!matchesRegion) return false;
      }

      if (prefs.domains && prefs.domains.length > 0) {
        if (!prefs.domains.includes(node.domain)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Parse preference headers
   */
  private parsePreferences(headers: Record<string, string>) {
    const get = (name: string) => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : null;
    };
    return {
      regions: get('x-node-region'),
      domains: get('x-node-domain'),
      exclude: get('x-node-exclude'),
    };
  }

  /**
   * Power of Two Choices - pick 2 random nodes, choose least loaded
   */
  private powerOfTwoChoices(eligibleNodes: any[]): any {
    if (eligibleNodes.length === 1) return eligibleNodes[0];

    const n    = eligibleNodes.length;
    const idx1 = Math.floor(Math.random() * n);
    // O(1): pick a uniformly-distributed index that is guaranteed !== idx1
    const idx2 = (idx1 + 1 + Math.floor(Math.random() * (n - 1))) % n;

    const node1 = eligibleNodes[idx1];
    const node2 = eligibleNodes[idx2];

    return this.load(node1.id) <= this.load(node2.id) ? node1 : node2;
  }

  /**
   * Increment HTTP request count for a node
   */
  incrementRequest(nodeId: string): void {
    this.activeRequests.set(nodeId, (this.activeRequests.get(nodeId) ?? 0) + 1);
    this.statsCache = null;
  }

  decrementRequest(nodeId: string): void {
    const next = Math.max(0, (this.activeRequests.get(nodeId) ?? 0) - 1);
    if (next === 0) this.activeRequests.delete(nodeId);
    else this.activeRequests.set(nodeId, next);
    this.statsCache = null;
  }

  incrementSession(nodeId: string): void {
    this.activeSessions.set(nodeId, (this.activeSessions.get(nodeId) ?? 0) + 1);
    this.statsCache = null;
  }

  decrementSession(nodeId: string): void {
    const next = Math.max(0, (this.activeSessions.get(nodeId) ?? 0) - 1);
    if (next === 0) this.activeSessions.delete(nodeId);
    else this.activeSessions.set(nodeId, next);
    this.statsCache = null;
  }

  getNodeLoad(nodeId: string): { requests: number; sessions: number; total: number } {
    const requests = this.activeRequests.get(nodeId) ?? 0;
    const sessions = this.activeSessions.get(nodeId) ?? 0;
    return { requests, sessions, total: requests + sessions };
  }

  // Separated so the return type can be inferred for statsCache typing.
  private _buildStats() {
    const allNodes    = this.nodeStore.listNodes();
    const activeNodes = allNodes.filter((n: any) => n.status === 'active');

    let totalReqs = 0; for (const v of this.activeRequests.values()) totalReqs += v;
    let totalSess = 0; for (const v of this.activeSessions.values()) totalSess += v;

    const httpLat = activeNodes
      .map((n: any) => n.capabilities?.fetch_latency_ms)
      .filter((v: unknown): v is number => typeof v === 'number' && v > 0);
    const avgHttpLatencyMs: number | null = httpLat.length
      ? Math.round(httpLat.reduce((a: number, b: number) => a + b, 0) / httpLat.length)
      : null;

    const wsLat = activeNodes
      .map((n: any) => n.heartbeat?.p95_ms)
      .filter((v: unknown): v is number => typeof v === 'number' && v > 0);
    const avgWsLatencyMs: number | null = wsLat.length
      ? Math.round(wsLat.reduce((a: number, b: number) => a + b, 0) / wsLat.length)
      : null;

    return {
      total_nodes:            allNodes.length,
      active_nodes:           activeNodes.length,
      saturation_load:        this.saturationLoad,
      total_active_requests:  totalReqs,
      total_active_sessions:  totalSess,
      avg_http_latency_ms:    avgHttpLatencyMs,
      avg_ws_latency_ms:      avgWsLatencyMs,
      sticky_mappings:        this.requestToNode.size,
      selection_stats: {
        total_selections: this.stats.total_selections,
        sticky_hits:      this.stats.sticky_hits,
        fallbacks:        this.stats.fallbacks,
        sticky_hit_rate:  this.stats.total_selections > 0
          ? ((this.stats.sticky_hits / this.stats.total_selections) * 100).toFixed(2) + '%'
          : '0%',
      },
      load_distribution: Array.from(this.activeRequests.keys()).map((nodeId) => {
        const node = this.nodeStore.getNode(nodeId);
        const reqs = this.activeRequests.get(nodeId) ?? 0;
        const sess = this.activeSessions.get(nodeId) ?? 0;
        return { node_id: nodeId, requests: reqs, sessions: sess, total: reqs + sess, region: node?.region, status: node?.status };
      }),
    };
  }

  getStats() {
    const now = Date.now();
    if (this.statsCache && (now - this.statsCache.at) < STATS_CACHE_MS) {
      return this.statsCache.value;
    }
    const value = this._buildStats();
    this.statsCache = { value, at: now };
    return value;
  }
}

function isNodeUpdating(node: any): boolean {
  const state = node?.capabilities?.update_state;
  return state === 'preparing' || state === 'ready' || state === 'draining' || state === 'updating';
}