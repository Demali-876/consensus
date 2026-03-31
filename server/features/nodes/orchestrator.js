import crypto from 'crypto';
import { paymentMiddleware } from '@x402/express';
import { benchmarkNode } from '../../utils/benchmark.js';
import { provisionNodeDNS } from '../../utils/dns.js';
import NodeStore from '../../data/node_store.js';
import { observeNode } from '../ip-pool/observer.ts';

const BASE_PRICE = 100;
const INCREMENT  = 50;
const MAX_PRICE  = 1000;

function calculateJoinPrice() {
  const nodeCount = NodeStore.listNodes().length;
  return Math.min(BASE_PRICE + nodeCount * INCREMENT, MAX_PRICE);
}

export function registerNodes(app, httpsServer, x402Server, config) {
  const { EVM_PAY_TO, SOLANA_PAY_TO, ICP_PAY_TO } = config;

  app.post(
    '/node/join',
    paymentMiddleware(
      {
        'POST /node/join': {
          accepts: [
            {
              scheme:  'exact',
              price:   () => `$${calculateJoinPrice()}`,
              network: 'eip155:84532',
              payTo:   EVM_PAY_TO,
            },
            {
              scheme:  'exact',
              price:   () => `$${calculateJoinPrice()}`,
              network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              payTo:   SOLANA_PAY_TO,
            },
          ],
          description: 'Join the Consensus Network',
          mimeType:    'application/json',
        },
      },
      x402Server,
    ),
    async (req, res) => {
      const startTime = Date.now();

      try {
        const {
          pubkey_secp256k1_pem,
          pubkey_ed25519_pem,
          ipv6,
          ipv4,
          port,
          test_endpoint,
          region,
          contact,
          evm_address,
          solana_address,
          icp_address,
          capabilities: declaredCapabilities,
        } = req.body;

        // ── Required field validation ─────────────────────────────────────────

        if (!ipv6 || !port || !test_endpoint || !region || !contact ||
            !evm_address || !solana_address || !icp_address) {
          return res.status(400).json({
            error: 'Missing required fields',
            required: [
              'ipv6', 'port', 'test_endpoint', 'region', 'contact',
              'evm_address', 'solana_address', 'icp_address',
            ],
          });
        }

        if (!pubkey_secp256k1_pem && !pubkey_ed25519_pem) {
          return res.status(400).json({
            error: 'At least one public key is required',
            fields: ['pubkey_secp256k1_pem', 'pubkey_ed25519_pem'],
          });
        }

        // ── Address format validation ─────────────────────────────────────────

        if (!ipv6.includes(':')) {
          return res.status(400).json({ error: 'Invalid IPv6 address format' });
        }
        if (!evm_address.startsWith('0x') || evm_address.length !== 42) {
          return res.status(400).json({ error: 'Invalid EVM address format' });
        }
        if (solana_address.length < 32 || solana_address.length > 44) {
          return res.status(400).json({ error: 'Invalid Solana address format' });
        }

        // ── Parse public keys ─────────────────────────────────────────────────

        let pubkeySecp256k1 = null;
        let pubkeyEd25519   = null;

        try {
          if (pubkey_secp256k1_pem) {
            pubkeySecp256k1 = crypto
              .createPublicKey(pubkey_secp256k1_pem)
              .export({ format: 'der', type: 'spki' });
          }
          if (pubkey_ed25519_pem) {
            pubkeyEd25519 = crypto
              .createPublicKey(pubkey_ed25519_pem)
              .export({ format: 'der', type: 'spki' });
          }
        } catch {
          return res.status(400).json({ error: 'Invalid public key PEM format' });
        }

        // ── Duplicate check ───────────────────────────────────────────────────

        console.log('\nPayment verified — processing node registration');
        console.log(`   IPv6: ${ipv6}:${port}`);
        console.log(`   Region: ${region}`);
        console.log(`   Keys: ${[pubkey_secp256k1_pem && 'secp256k1', pubkey_ed25519_pem && 'ed25519'].filter(Boolean).join(', ')}`);

        const duplicate = NodeStore.listNodes().find(
          (n) => n.capabilities?.ipv6 === ipv6,
        );
        if (duplicate) {
          return res.status(409).json({
            error:            'IPv6 already registered',
            existing_node_id: duplicate.id,
          });
        }

        // ── Benchmark ─────────────────────────────────────────────────────────

        console.log('\nRunning benchmark tests...');
        const benchmarkResult = await benchmarkNode(test_endpoint);

        if (!benchmarkResult.passed) {
          console.log(`  Benchmark failed: ${benchmarkResult.score}/100\n`);
          return res.status(400).json({
            error:          'Node performance below minimum requirements',
            score:          benchmarkResult.score,
            required_score: 60,
            details:        benchmarkResult.details,
          });
        }
        console.log(` Benchmark passed: ${benchmarkResult.score}/100`);

        // ── DNS ───────────────────────────────────────────────────────────────

        const nodeId    = crypto.randomBytes(6).toString('hex');
        const subdomain = `${nodeId}.consensus.canister.software`;

        console.log(`\nNode ID:   ${nodeId}`);
        console.log(`Subdomain: ${subdomain}`);
        console.log('\nProvisioning DNS...');

        try {
          await provisionNodeDNS(subdomain, ipv6, ipv4);
          console.log(' DNS provisioned');
        } catch (dnsError) {
          console.error(`DNS failed: ${dnsError.message}\n`);
          return res.status(500).json({ error: 'DNS provisioning failed', message: dnsError.message });
        }

        // ── Store ─────────────────────────────────────────────────────────────

        console.log('\nStoring node...');
        NodeStore.upsertNode({
          id:               nodeId,
          pubkey_secp256k1: pubkeySecp256k1,
          pubkey_ed25519:   pubkeyEd25519,
          region,
          contact,
          capabilities: {
            forward_proxy:   declaredCapabilities?.forward_proxy   ?? false,
            reverse_proxy:   declaredCapabilities?.reverse_proxy   ?? false,
            websockets:      declaredCapabilities?.websockets       ?? false,
            tunnels:         declaredCapabilities?.tunnels          ?? false,
            ip_leasing:      declaredCapabilities?.ip_leasing       ?? false,
            benchmark_score: benchmarkResult.score,
            fetch_latency_ms: benchmarkResult.details.fetch.avg_latency_ms,
            cpu_performance:  benchmarkResult.details.cpu.hashes_per_second,
            ipv4:  ipv4 || null,
            ipv6,
            port,
          },
          evm_address,
          solana_address,
          icp_address,
          status: 'active',
        });

        NodeStore.setDomain(nodeId, subdomain);
        console.log(' Node stored');

        // ── First observation ─────────────────────────────────────────────────

        observeNode(nodeId, ipv4 || null, ipv6).catch((err) =>
          console.error(`[Observer] Initial observation failed for ${nodeId}:`, err),
        );

        // ── Response ──────────────────────────────────────────────────────────

        const processingTime = Date.now() - startTime;
        const paidPrice      = calculateJoinPrice();

        console.log(`\n✅ Node registered in ${processingTime}ms — price paid: $${paidPrice}\n`);

        res.json({
          success:          true,
          node_id:          nodeId,
          domain:           subdomain,
          ipv6,
          ipv4:             ipv4 || null,
          port,
          status:           'active',
          benchmark_score:  benchmarkResult.score,
          price_paid:       paidPrice,
          processing_time_ms: processingTime,
          next_steps: [
            'DNS propagation may take up to 5 minutes',
            `Send heartbeat every 5 minutes to /node/heartbeat/${nodeId}`,
            `Monitor status at /node/status/${nodeId}`,
          ],
        });
      } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed', message: error.message });
      }
    },
  );

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  app.post('/node/heartbeat/:node_id', (req, res) => {
    try {
      const { node_id } = req.params;
      const { rps, p95_ms, version } = req.body;

      const node = NodeStore.getNode(node_id);
      if (!node) return res.status(404).json({ error: 'Node not found' });

      NodeStore.heartbeat(node_id, { rps, p95_ms, version });

      res.json({ success: true, node_id, message: 'Heartbeat recorded', next_heartbeat_in: 300 });
    } catch (error) {
      console.error('Heartbeat error:', error);
      res.status(500).json({ error: 'Heartbeat failed', message: error.message });
    }
  });

  // ── Status ──────────────────────────────────────────────────────────────────

  app.get('/node/status/:node_id', (req, res) => {
    try {
      const node = NodeStore.getNode(req.params.node_id);
      if (!node) return res.status(404).json({ error: 'Node not found' });

      res.json({
        node_id:      node.id,
        domain:       node.domain,
        status:       node.status,
        region:       node.region,
        contact:      node.contact,
        capabilities: node.capabilities,
        created_at:   node.created_at,
        updated_at:   node.updated_at,
        heartbeat:    node.heartbeat,
      });
    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({ error: 'Failed to get status', message: error.message });
    }
  });

  // ── List ────────────────────────────────────────────────────────────────────

  app.get('/nodes', (req, res) => {
    try {
      const nodes = NodeStore.listNodes();
      res.json({
        total:              nodes.length,
        current_join_price: calculateJoinPrice(),
        nodes: nodes.map((n) => ({
          node_id:         n.id,
          domain:          n.domain,
          status:          n.status,
          region:          n.region,
          capabilities:    n.capabilities,
          evm_address:     n.evm_address,
          solana_address:  n.solana_address,
          icp_address:     n.icp_address,
          created_at:      n.created_at,
          heartbeat:       n.heartbeat,
        })),
      });
    } catch (error) {
      console.error('List nodes error:', error);
      res.status(500).json({ error: 'Failed to list nodes', message: error.message });
    }
  });

  return {
    getStats: () => ({
      total_nodes:        NodeStore.listNodes().length,
      current_join_price: calculateJoinPrice(),
    }),
  };
}
