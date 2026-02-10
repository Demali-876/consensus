import NodeStore from "./data/node_store.js";

interface RouterStats {
  total_selections: number;
  sticky_hits: number;
  fallbacks: number;
}

/**
* Router - Routes requests to available instances
*/
export default class Router {
  private activeRequests: Map<string, number>;  // nodeId → count of HTTP requests
  private activeSessions: Map<string, number>;  // nodeId → count of open WebSockets
  private requestToNode: Map<string, string>;   // dedupeKey → nodeId
  private stats: RouterStats;

  constructor() {
    this.activeRequests = new Map();
    this.activeSessions = new Map();
    this.requestToNode = new Map();
    this.stats = {
      total_selections: 0,
      sticky_hits: 0,
      fallbacks: 0,
    };
  }

  /**
 * Select a node for a request
 * @param dedupeKey - Unique request identifier
 * @param preferenceHeaders - User preferences (x-node-region, etc.)
 * @returns Selected node or null if none available
 */
 selectNode(dedupeKey: string, preferenceHeaders: Record<string, string> = {}): any | null {
  this.stats.total_selections++;

  const stickyNodeId = this.requestToNode.get(dedupeKey);
  if (stickyNodeId) {
    const node = NodeStore.getNode(stickyNodeId);
    if (node && node.status === "active") {
      this.stats.sticky_hits++;
      console.log(`[Sticky Route] ${dedupeKey.substring(0, 12)}... → ${stickyNodeId}`);
      return node;
    } else {
      this.requestToNode.delete(dedupeKey);
    }
  }

  const allNodes = NodeStore.listNodes();
  let eligibleNodes = allNodes.filter((node: any) => node.status === 'active');

  eligibleNodes = this.filterByPreferences(eligibleNodes, preferenceHeaders);

  if (eligibleNodes.length === 0) {
    this.stats.fallbacks++;
    return null;
  }
  
  const selectedNode = this.powerOfTwoChoices(eligibleNodes);
  this.requestToNode.set(dedupeKey, selectedNode.id);
  
  return selectedNode;
}
/**
 * Filter nodes by user preferences
 */
private filterByPreferences(nodes: any[], headers: Record<string, string>): any[] {
  const prefs = this.parsePreferences(headers);
  
  return nodes.filter(node => {
    if (prefs.exclude?.includes(node.id)) {
      return false;
    }
    if (prefs.regions && prefs.regions.length > 0) {
      const matchesRegion = prefs.regions.some(r => 
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
  const getHeader = (name: string) => {
    const value = headers[name] || headers[name.toLowerCase()];
    return value ? String(value).split(',').map(s => s.trim()).filter(Boolean) : null;
  };

  return {
    regions: getHeader('x-node-region') || getHeader('X-Node-Region'),
    domains: getHeader('x-node-domain') || getHeader('X-Node-Domain'),
    exclude: getHeader('x-node-exclude') || getHeader('X-Node-Exclude'),
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

  const load1 = (this.activeRequests.get(node1.id) || 0) + (this.activeSessions.get(node1.id) || 0);
  const load2 = (this.activeRequests.get(node2.id) || 0) + (this.activeSessions.get(node2.id) || 0);

  return load1 <= load2 ? node1 : node2;
}

/**
 * Increment HTTP request count for a node
 */
incrementRequest(nodeId: string): void {
  const current = this.activeRequests.get(nodeId) || 0;
  this.activeRequests.set(nodeId, current + 1);
}

/**
 * Decrement HTTP request count for a node
 */
decrementRequest(nodeId: string): void {
  const current = this.activeRequests.get(nodeId) || 0;
  this.activeRequests.set(nodeId, Math.max(0, current - 1));
}

/**
 * Increment WebSocket session count for a node
 */
incrementSession(nodeId: string): void {
  const current = this.activeSessions.get(nodeId) || 0;
  this.activeSessions.set(nodeId, current + 1);
}

/**
 * Decrement WebSocket session count for a node
 */
decrementSession(nodeId: string): void {
  const current = this.activeSessions.get(nodeId) || 0;
  this.activeSessions.set(nodeId, Math.max(0, current - 1));
}

/**
 * Get router statistics
 */
getStats() {
  const allNodes = NodeStore.listNodes();
  const activeNodes = allNodes.filter((n:any) => n.status === 'active');

  return {
    total_nodes: allNodes.length,
    active_nodes: activeNodes.length,
    total_active_requests: Array.from(this.activeRequests.values()).reduce((sum, v) => sum + v, 0),
    total_active_sessions: Array.from(this.activeSessions.values()).reduce((sum, v) => sum + v, 0),
    sticky_mappings: this.requestToNode.size,
    
    selection_stats: {
      total_selections: this.stats.total_selections,
      sticky_hits: this.stats.sticky_hits,
      fallbacks: this.stats.fallbacks,
      sticky_hit_rate: this.stats.total_selections > 0 
        ? ((this.stats.sticky_hits / this.stats.total_selections) * 100).toFixed(2) + '%'
        : '0%',
    },

    load_distribution: Array.from(this.activeRequests.keys()).map(nodeId => {
      const node = NodeStore.getNode(nodeId);
      return {
        node_id: nodeId,
        requests: this.activeRequests.get(nodeId) || 0,
        sessions: this.activeSessions.get(nodeId) || 0,
        total: (this.activeRequests.get(nodeId) || 0) + (this.activeSessions.get(nodeId) || 0),
        region: node?.region,
        status: node?.status,
      };
    }),
  };
}
}
