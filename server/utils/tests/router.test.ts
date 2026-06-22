import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Router from '../../router.ts';

const node = (id: string, extra: Record<string, any> = {}) => ({
  id,
  status: 'active',
  region: 'us-east',
  domain: `${id}.consensus.test`,
  capabilities: {},
  ...extra,
});

// Minimal NodeStore stand-in; the router only needs these three.
function storeOf(nodes: any[]) {
  return {
    listNodesForRouting: () => nodes,
    listNodes: () => nodes,
    getNode: (id: string) => nodes.find((n) => n.id === id) ?? null,
  };
}

describe('Router — prefer downstream nodes, orchestrator as last resort', () => {
  it('routes every request to the downstream node (never self) while it has capacity', () => {
    const router = new Router(storeOf([node('n1'), node('server')]), { saturationLoad: 100 });
    const picked = new Set<string>();
    for (let i = 0; i < 50; i++) picked.add(router.selectNode(`k${i}`).id);
    assert.deepEqual([...picked], ['n1'], 'only the downstream node is selected');
  });

  it('spills to self only once the node reaches the saturation load, then returns', () => {
    const router = new Router(storeOf([node('n1'), node('server')]), { saturationLoad: 2 });
    assert.equal(router.selectNode('a').id, 'n1'); // load 0
    router.incrementRequest('n1'); // load 1
    assert.equal(router.selectNode('b').id, 'n1');
    router.incrementRequest('n1'); // load 2 == threshold → saturated
    assert.equal(router.selectNode('c').id, 'server', 'falls back to self when saturated');
    router.decrementRequest('n1'); // load 1 → capacity again
    assert.equal(router.selectNode('d').id, 'n1', 'returns to the node once it frees up');
  });

  it('balances across multiple nodes and never picks self while any has capacity', () => {
    const router = new Router(storeOf([node('n1'), node('n2'), node('server')]), { saturationLoad: 1000 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const id = router.selectNode(`k${i}`).id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    assert.ok(counts.n1 > 0 && counts.n2 > 0, 'both downstream nodes are used');
    assert.equal(counts.server, undefined, 'self is never selected while nodes have capacity');
  });

  it('honours sticky routing for repeat dedupe keys', () => {
    const router = new Router(storeOf([node('n1'), node('n2'), node('server')]), { saturationLoad: 1000 });
    const first = router.selectNode('same').id;
    for (let i = 0; i < 20; i++) assert.equal(router.selectNode('same').id, first, 'sticks to the first node');
  });

  it('falls back to self (or null) when no downstream node is eligible', () => {
    assert.equal(new Router(storeOf([node('server')]), { saturationLoad: 100 }).selectNode('k').id, 'server');
    assert.equal(new Router(storeOf([]), { saturationLoad: 100 }).selectNode('k'), null);
    const updating = new Router(
      storeOf([node('n1', { capabilities: { update_state: 'draining' } }), node('server')]),
      { saturationLoad: 100 },
    );
    assert.equal(updating.selectNode('k').id, 'server', 'a node mid-update is skipped, self used');
  });

  it('spills to self when every downstream node is saturated', () => {
    const router = new Router(storeOf([node('n1'), node('n2'), node('server')]), { saturationLoad: 1 });
    router.incrementRequest('n1');
    router.incrementRequest('n2');
    assert.equal(router.selectNode('k').id, 'server');
  });

  it('applies x-node-exclude before deciding to fall back', () => {
    const router = new Router(storeOf([node('n1'), node('server')]), { saturationLoad: 100 });
    assert.equal(router.selectNode('k', { 'x-node-exclude': 'n1' }).id, 'server', 'excluded node → self');
  });

  it('never routes an x-node-exclude: server request to self, even under saturation', () => {
    // Unsaturated: routes to the node as normal.
    const fresh = new Router(storeOf([node('n1'), node('server')]), { saturationLoad: 100 });
    assert.equal(fresh.selectNode('a', { 'x-node-exclude': 'server' }).id, 'n1');

    // Node saturated + self excluded: overflow back onto the node, NOT self.
    const busy = new Router(storeOf([node('n1'), node('server')]), { saturationLoad: 1 });
    busy.incrementRequest('n1'); // n1 now saturated
    assert.equal(busy.selectNode('b', { 'x-node-exclude': 'server' }).id, 'n1', 'overflow to node, not self');

    // Self excluded and no downstream node at all: null, never self.
    const lonely = new Router(storeOf([node('server')]), { saturationLoad: 1 });
    assert.equal(lonely.selectNode('c', { 'x-node-exclude': 'server' }), null);
  });
});
