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

export default class Router {
  private activeRequests: Map<string, number>;           // nodeId → HTTP request count
  private activeSessions: Map<string, number>;           // nodeId → WebSocket session count
  private requestToNode:  Map<string, { nodeId: string; at: number }>; // dedupeKey → sticky
  private stats: RouterStats;
  private statsCache: { value: ReturnType<Router['_buildStats']>; at: number } | null = null;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
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
  selectNode(dedupeKey: string, preferenceHeaders: Record<string, string> = {}): any | null {
    this.stats.total_selections++;

    const sticky = this.requestToNode.get(dedupeKey);
    if (sticky) {
      const node = NodeStore.getNode(sticky.nodeId);
      if (node && node.status === 'active' && !isNodeUpdating(node)) {
        this.stats.sticky_hits++;
        return node;
      }
      this.requestToNode.delete(dedupeKey);
    }

    const allNodes = NodeStore.listNodes();
    let eligibleNodes = allNodes.filter((node: any) =>
      node.status === 'active' && !isNodeUpdating(node),
    );

    eligibleNodes = this.filterByPreferences(eligibleNodes, preferenceHeaders);

    if (eligibleNodes.length === 0) {
      this.stats.fallbacks++;
      return null;
    }

    const selectedNode = this.powerOfTwoChoices(eligibleNodes);
    this.requestToNode.set(dedupeKey, { nodeId: selectedNode.id, at: Date.now() });
    return selectedNode;
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

    const idx1 = Math.floor(Math.random() * eligibleNodes.length);
    let idx2 = Math.floor(Math.random() * eligibleNodes.length);

    while (idx2 === idx1 && eligibleNodes.length > 1) {
      idx2 = Math.floor(Math.random() * eligibleNodes.length);
    }

    const node1 = eligibleNodes[idx1];
    const node2 = eligibleNodes[idx2];

    const load1 =
      (this.activeRequests.get(node1.id) || 0) + (this.activeSessions.get(node1.id) || 0);
    const load2 =
      (this.activeRequests.get(node2.id) || 0) + (this.activeSessions.get(node2.id) || 0);

    return load1 <= load2 ? node1 : node2;
  }

  /**
   * Increment HTTP request count for a node
   */
  incrementRequest(nodeId: string): void {
    this.activeRequests.set(nodeId, (this.activeRequests.get(nodeId) ?? 0) + 1);
    this.statsCache = null;
  }

  decrementRequest(nodeId: string): void {
    this.activeRequests.set(nodeId, Math.max(0, (this.activeRequests.get(nodeId) ?? 0) - 1));
    this.statsCache = null;
  }

  incrementSession(nodeId: string): void {
    this.activeSessions.set(nodeId, (this.activeSessions.get(nodeId) ?? 0) + 1);
    this.statsCache = null;
  }

  decrementSession(nodeId: string): void {
    this.activeSessions.set(nodeId, Math.max(0, (this.activeSessions.get(nodeId) ?? 0) - 1));
    this.statsCache = null;
  }

  getNodeLoad(nodeId: string): { requests: number; sessions: number; total: number } {
    const requests = this.activeRequests.get(nodeId) ?? 0;
    const sessions = this.activeSessions.get(nodeId) ?? 0;
    return { requests, sessions, total: requests + sessions };
  }

  // Separated so the return type can be inferred for statsCache typing.
  private _buildStats() {
    const allNodes    = NodeStore.listNodes();
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
        const node = NodeStore.getNode(nodeId);
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
