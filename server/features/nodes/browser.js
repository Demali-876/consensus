import NodeStore from '../../data/node_store.js';

const PUBLIC_CAPABILITY_FLAGS = [
  'forward_proxy',
  'reverse_proxy',
  'websockets',
  'tunnels',
  'ip_leasing',
];

const HEARTBEAT_STALE_AFTER_S = 10 * 60;

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number != null && Number.isInteger(number) ? number : null;
}

function stringOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function publicCapabilities(capabilities = {}) {
  return Object.fromEntries(
    PUBLIC_CAPABILITY_FLAGS.map((flag) => [flag, capabilities[flag] === true]),
  );
}

function connectedControlSession(nodeTunnel, nodeId) {
  const session = nodeTunnel?.getNodeSession?.(nodeId);
  if (!session || session.mode !== 'control' || session.ws?.readyState !== 1) return null;
  return session;
}

export function browserNode(node, options = {}) {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const capabilities = node.capabilities ?? {};
  const heartbeat = node.heartbeat ?? {};
  const session = connectedControlSession(options.nodeTunnel, node.id);
  const load = options.router?.getNodeLoad?.(node.id) ?? {};
  const heartbeatAt = integerOrNull(heartbeat.at);
  const sessionSeenAt = session?.lastSeenAt == null
    ? null
    : Math.floor(Number(session.lastSeenAt) / 1000);
  const lastSeenAt = Math.max(
    heartbeatAt ?? 0,
    Number.isFinite(sessionSeenAt) ? sessionSeenAt : 0,
  ) || null;
  const heartbeatAge = lastSeenAt == null ? null : Math.max(0, nowSeconds - lastSeenAt);
  const status = stringOrNull(node.status) ?? 'unknown';

  let availability = 'unknown';
  if (status !== 'active') availability = 'offline';
  else if (node.id === 'server' || session) availability = 'online';
  else if (heartbeatAge != null) {
    availability = heartbeatAge <= HEARTBEAT_STALE_AFTER_S ? 'online' : 'stale';
  }

  return {
    node_id:          String(node.id),
    domain:           stringOrNull(node.domain),
    region:           stringOrNull(node.region) ?? 'unknown',
    status,
    ipv4:             stringOrNull(capabilities.ipv4),
    ipv6:             stringOrNull(capabilities.ipv6),
    benchmark_score:  numberOrNull(capabilities.benchmark_score),
    latency_ms:       numberOrNull(heartbeat.p95_ms) ?? numberOrNull(capabilities.fetch_latency_ms),
    active_requests:  integerOrNull(load.requests) ?? 0,
    active_sessions:  integerOrNull(load.sessions) ?? 0,
    availability,
    last_seen_at:     lastSeenAt,
    version:          stringOrNull(session?.version) ?? stringOrNull(heartbeat.version),
    control_tunnel_connected: Boolean(session),
    capabilities:     publicCapabilities(capabilities),
  };
}

export function registerNodeBrowser(app, { router, nodeTunnel } = {}) {
  app.get('/nodes/browser', (req, res) => {
    try {
      const region = String(req.query.region ?? '').trim().toLowerCase();
      const nodes = NodeStore.listNodes()
        .filter((node) => !region || String(node.region ?? '').toLowerCase().includes(region))
        .map((node) => browserNode(node, { router, nodeTunnel }));

      res.json({ total: nodes.length, nodes });
    } catch (error) {
      console.error('Node browser error:', error);
      res.status(500).json({ error: 'Failed to list browser nodes', message: error.message });
    }
  });
}
