import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserNode } from '../../features/nodes/browser.js';

const capabilities = {
  forward_proxy: true,
  reverse_proxy: true,
  websockets: true,
  tunnels: true,
  ip_leasing: true,
  benchmark_score: 91,
  ipv4: '203.0.113.10',
  ipv6: '2001:db8::10',
  private_token: 'must-not-leak',
};

describe('node browser projection', () => {
  it('composes existing node, heartbeat, router, and control-session data', () => {
    const result = browserNode({
      id: 'node-1',
      domain: 'node-1.example.test',
      region: 'us-east',
      status: 'active',
      contact: 'private@example.test',
      capabilities,
      heartbeat: {
        rps: 12,
        p95_ms: 45,
        version: 'node/1.0.0',
        at: 1_700_000_100,
      },
    }, {
      nowSeconds: 1_700_000_110,
      router: {
        getNodeLoad: () => ({ requests: 2, sessions: 1, total: 3 }),
      },
      nodeTunnel: {
        getNodeSession: () => ({
          mode: 'control',
          ws: { readyState: 1 },
          version: 'node/1.1.0',
          lastSeenAt: 1_700_000_105_000,
        }),
      },
    });

    assert.deepEqual(result, {
      node_id: 'node-1',
      domain: 'node-1.example.test',
      region: 'us-east',
      status: 'active',
      ipv4: '203.0.113.10',
      ipv6: '2001:db8::10',
      benchmark_score: 91,
      latency_ms: 45,
      active_requests: 2,
      active_sessions: 1,
      availability: 'online',
      last_seen_at: 1_700_000_105,
      version: 'node/1.1.0',
      control_tunnel_connected: true,
      capabilities: {
        forward_proxy: true,
        reverse_proxy: true,
        websockets: true,
        tunnels: true,
        ip_leasing: true,
      },
    });
    assert.equal('contact' in result, false);
    assert.equal('private_token' in result.capabilities, false);
  });

  it('reports stale nodes without requiring a control tunnel or protocol change', () => {
    const result = browserNode({
      id: 'node-2',
      domain: null,
      region: 'eu-west',
      status: 'active',
      capabilities: {},
      heartbeat: { p95_ms: null, version: 'node/0.9.0', at: 1_700_000_000 },
    }, {
      nowSeconds: 1_700_001_000,
      router: { getNodeLoad: () => ({ requests: 0, sessions: 0, total: 0 }) },
      nodeTunnel: { getNodeSession: () => null },
    });

    assert.equal(result.availability, 'stale');
    assert.equal(result.control_tunnel_connected, false);
    assert.equal(result.version, 'node/0.9.0');
    assert.equal(result.latency_ms, null);
  });

  it('treats the active orchestrator node as online without a self-tunnel', () => {
    const result = browserNode({
      id: 'server',
      domain: null,
      region: 'unknown',
      status: 'active',
      capabilities: {},
      heartbeat: null,
    });

    assert.equal(result.availability, 'online');
    assert.equal(result.control_tunnel_connected, false);
  });
});
