import crypto                from 'crypto';
import { isIPv4, isIPv6 }   from 'node:net';
import rateLimit             from 'express-rate-limit';
import { paymentMiddleware } from '@x402/express';
import NodeStore             from '../../data/node_store.js';
import { observeNode }       from '../ip-pool/observer.ts';
import { classifyIpRegion }  from '../../utils/region.ts';
import { assertEmailVerification, isValidEmail, startEmailVerification, verifyEmailCode } from '../../utils/email-verification.ts';
import { orchestratorPinForJoin } from '../tickets/pubkey.ts';
import { nodeGatewayConnectUrl, publicNodeDomain } from '../node-gateway/domain.ts';

const emailStartLimiter = rateLimit({
  windowMs:          10 * 60_000,
  max:               5,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too Many Requests' },
});

const emailVerifyLimiter = rateLimit({
  windowMs:          10 * 60_000,
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too Many Requests' },
});

const joinLimiter = rateLimit({
  windowMs:          10 * 60_000,
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too Many Requests' },
});

function requireLoopback(req, res, next) {
  const remote = req.socket.remoteAddress ?? '';
  const ok = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (ok) return next();
  console.warn(`[Nodes] Blocked unauthorised DELETE from ${remote}`);
  return res.status(403).json({ error: 'Forbidden' });
}

const BASE_PRICE = 100;
const INCREMENT  = 50;
const MAX_PRICE  = 1000;

function calculateJoinPrice() {
  return Math.min(BASE_PRICE + NodeStore.countNodes() * INCREMENT, MAX_PRICE);
}

function verifyJoinRequest({ join_id, join_signature, pubkey_ed25519_pem }) {
  if (!join_id && !join_signature) return null;
  if (!join_id || !join_signature) {
    const error = new Error('join_id and join_signature must be provided together');
    error.statusCode = 400;
    throw error;
  }
  if (!pubkey_ed25519_pem) {
    const error = new Error('pubkey_ed25519_pem is required when using join request authorization');
    error.statusCode = 400;
    throw error;
  }

  const join = NodeStore.getJoin(join_id);
  if (!join) {
    const error = new Error('Join request not found');
    error.statusCode = 404;
    throw error;
  }
  if (join.consumed_at != null) {
    const error = new Error('Join request already consumed');
    error.statusCode = 409;
    throw error;
  }
  if (join.expires_at < Math.floor(Date.now() / 1000)) {
    const error = new Error('Join request expired');
    error.statusCode = 410;
    throw error;
  }
  if (join.alg !== 'ed25519') {
    const error = new Error(`Unsupported join request algorithm: ${join.alg}`);
    error.statusCode = 400;
    throw error;
  }

  let requestPubkey;
  let bodyPubkey;
  try {
    requestPubkey = crypto.createPublicKey({ key: join.node_pubkey, format: 'der', type: 'spki' });
    bodyPubkey = crypto.createPublicKey(pubkey_ed25519_pem);
  } catch {
    const error = new Error('Invalid join request public key');
    error.statusCode = 400;
    throw error;
  }

  const requestDer = requestPubkey.export({ format: 'der', type: 'spki' });
  const bodyDer = bodyPubkey.export({ format: 'der', type: 'spki' });
  if (requestDer.length !== bodyDer.length || !crypto.timingSafeEqual(Buffer.from(requestDer), Buffer.from(bodyDer))) {
    const error = new Error('Join request public key does not match node public key');
    error.statusCode = 401;
    throw error;
  }

  const verified = crypto.verify(
    null,
    join.nonce,
    requestPubkey,
    Buffer.from(join_signature, 'base64'),
  );
  if (!verified) {
    const error = new Error('Join request signature verification failed');
    error.statusCode = 401;
    throw error;
  }

  return join;
}

function sameKey(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PUBLIC_CAPABILITY_FLAGS = [
  'forward_proxy',
  'reverse_proxy',
  'websockets',
  'tunnels',
  'ip_leasing',
];

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function publicCapabilities(capabilities = {}) {
  const publicCaps = {};
  for (const key of PUBLIC_CAPABILITY_FLAGS) {
    publicCaps[key] = capabilities[key] === true;
  }
  publicCaps.benchmark_score = numberOrNull(capabilities.benchmark_score);
  return publicCaps;
}

function publicUpdate(capabilities = {}) {
  if (!capabilities.update_state) return null;
  return {
    state:          String(capabilities.update_state),
    target_version: capabilities.update_target_version ?? null,
    at:             capabilities.update_at ?? null,
  };
}

function publicHeartbeat(heartbeat) {
  if (!heartbeat) return null;
  return {
    version: heartbeat.version ?? null,
    at:      heartbeat.at ?? null,
  };
}

function publicNode(node) {
  const capabilities = node.capabilities ?? {};
  return {
    node_id:         node.id,
    domain:          node.domain,
    status:          node.status,
    region:          node.region,
    capabilities:    publicCapabilities(capabilities),
    benchmark_score: numberOrNull(capabilities.benchmark_score),
    update:          publicUpdate(capabilities),
    created_at:      node.created_at,
    heartbeat:       publicHeartbeat(node.heartbeat),
  };
}

export function registerNodes(app, httpsServer, x402Server, config) {
  const { EVM_PAY_TO, SOLANA_PAY_TO, ICP_PAY_TO } = config;

  app.post('/node/email/start', emailStartLimiter, async (req, res) => {
    try {
      const email = String(req.body?.email ?? '').trim();
      const verification = await startEmailVerification(email);
      res.json({ success: true, ...verification });
    } catch (error) {
      res.status(400).json({ error: 'Email verification failed', message: error.message });
    }
  });

  app.post('/node/email/verify', emailVerifyLimiter, async (req, res) => {
    try {
      const verified = verifyEmailCode({
        verification_id: String(req.body?.verification_id ?? ''),
        email: String(req.body?.email ?? ''),
        code: String(req.body?.code ?? ''),
      });
      res.json({ success: true, email: verified.email, email_verification_token: verified.token, expires_at: verified.expires_at });
    } catch (error) {
      res.status(400).json({ error: 'Email verification failed', message: error.message });
    }
  });

  app.get('/node/region/:ipv4', async (req, res) => {
    try {
      if (!isIPv4(req.params.ipv4)) return res.status(400).json({ error: 'Invalid IPv4 address format' });
      const geo = await classifyIpRegion(req.params.ipv4);
      res.json({ success: true, ...geo });
    } catch (error) {
      res.status(400).json({ error: 'Region classification failed', message: error.message });
    }
  });

  const joinHandlers = [];
  if (process.env.FREE_MODE !== 'true') {
    joinHandlers.push(paymentMiddleware(
      {
        'POST /node/join': {
          accepts: [
            { scheme: 'exact', price: () => `$${calculateJoinPrice()}`, network: 'eip155:84532',                             payTo: EVM_PAY_TO    },
            { scheme: 'exact', price: () => `$${calculateJoinPrice()}`, network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', payTo: SOLANA_PAY_TO },
          ],
          description: 'Join the Consensus Network',
          mimeType:    'application/json',
        },
      },
      x402Server,
    ));
  }

  app.post(
    '/node/join',
    joinLimiter,
    ...joinHandlers,
    async (req, res) => {
      const startTime = Date.now();
      const paidPrice = calculateJoinPrice();

      try {
        const {
          pubkey_secp256k1_pem,
          pubkey_ed25519_pem,
          ipv6,
          ipv4,
          port,
          contact,
          email_verification_token,
          evm_address,
          solana_address,
          icp_address,
          capabilities: declaredCapabilities,
          join_id,
          join_signature,
        } = req.body;

        if (!ipv4 || !port || !contact ||
            !evm_address || !solana_address || !icp_address) {
          return res.status(400).json({
            error:    'Missing required fields',
            required: ['ipv4', 'port', 'contact', 'email_verification_token', 'evm_address', 'solana_address', 'icp_address'],
          });
        }

        if (String(contact).length > 256) return res.status(400).json({ error: 'contact too long (max 256)' });
        if (!isValidEmail(String(contact))) return res.status(400).json({ error: 'contact must be a valid email address' });

        if (!pubkey_secp256k1_pem && !pubkey_ed25519_pem) {
          return res.status(400).json({ error: 'At least one public key is required', fields: ['pubkey_secp256k1_pem', 'pubkey_ed25519_pem'] });
        }

        if (ipv6 != null && ipv6 !== '' && !isIPv6(ipv6)) {
          return res.status(400).json({ error: 'Invalid IPv6 address format' });
        }
        if (!isIPv4(String(ipv4))) {
          return res.status(400).json({ error: 'Invalid IPv4 address format' });
        }

        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          return res.status(400).json({ error: 'Invalid port: must be an integer 1-65535' });
        }
        if (!evm_address.startsWith('0x') || evm_address.length !== 42) {
          return res.status(400).json({ error: 'Invalid EVM address format' });
        }
        if (solana_address.length < 32 || solana_address.length > 44) {
          return res.status(400).json({ error: 'Invalid Solana address format' });
        }

        try {
          assertEmailVerification({ email: String(contact), token: email_verification_token });
        } catch (error) {
          return res.status(401).json({ error: 'Email is not verified', message: error.message });
        }

        let geoRegion;
        try {
          geoRegion = await classifyIpRegion(String(ipv4));
        } catch (error) {
          return res.status(400).json({ error: 'Failed to classify IPv4 region', message: error.message });
        }
        const region = geoRegion.region;

        let pubkeySecp256k1 = null;
        let pubkeyEd25519   = null;

        try {
          if (pubkey_secp256k1_pem) pubkeySecp256k1 = crypto.createPublicKey(pubkey_secp256k1_pem).export({ format: 'der', type: 'spki' });
          if (pubkey_ed25519_pem)   pubkeyEd25519   = crypto.createPublicKey(pubkey_ed25519_pem).export({ format: 'der', type: 'spki' });
        } catch {
          return res.status(400).json({ error: 'Invalid public key PEM format' });
        }

        let verifiedJoin = null;
        try {
          verifiedJoin = verifyJoinRequest({ join_id, join_signature, pubkey_ed25519_pem });
        } catch (error) {
          return res.status(error.statusCode ?? 400).json({
            error: 'Join request verification failed',
            message: error.message,
          });
        }

        // Eval is mandatory: registration requires a valid, signed, eval-issued
        // join authorization (except in FREE_MODE dev, which also skips payment).
        // This closes the eval→join→control chain — only a node that passed the
        // encrypted eval (proving its identity, integrity, and capacity) can
        // register, and verifyJoinRequest above proved it still holds that same
        // identity (pubkey match + nonce signature). Without this, a node could
        // skip eval entirely and register with benchmark_score 0.
        if (!verifiedJoin && process.env.FREE_MODE !== 'true') {
          return res.status(403).json({
            error: 'Eval required',
            message: 'Registration requires a valid eval-issued join authorization. Run the node eval first.',
          });
        }

        console.log('\nPayment verified — processing node registration');
        console.log(`   IPv4: ${ipv4}:${port}`);
        if (ipv6) console.log(`   IPv6: ${ipv6}:${port}`);
        console.log(`   Region: ${region}`);
        console.log(`   Keys: ${[pubkey_secp256k1_pem && 'secp256k1', pubkey_ed25519_pem && 'ed25519'].filter(Boolean).join(', ')}`);

        const duplicate = NodeStore.listNodes().find((n) =>
          sameKey(n.pubkey_ed25519, pubkeyEd25519) ||
          sameKey(n.pubkey_secp256k1, pubkeySecp256k1)
        );
        if (duplicate) {
          return res.status(409).json({
            error: 'Node identity already registered',
            existing_node_id: duplicate.id,
            existing_domain: duplicate.domain ?? null,
          });
        }

        const benchmarkScore = verifiedJoin?.benchmark_score ?? 0;
        const benchmarkDetails = verifiedJoin?.benchmark_details ?? null;
        console.log(` Encrypted eval benchmark accepted: ${benchmarkScore}/100`);

        const nodeId     = crypto.randomBytes(6).toString('hex');
        const subdomain  = publicNodeDomain(nodeId);
        const connectUrl = nodeGatewayConnectUrl(nodeId);

        console.log(`\nNode ID:   ${nodeId}`);
        console.log(`Subdomain: ${subdomain}`);
        console.log(`Connect:   ${connectUrl}`);
        console.log('Gateway routing uses the node control tunnel; no per-node DNS record is provisioned.');

        let consumedJoin = null;
        try {
          consumedJoin = NodeStore.consumeJoin(join_id);
        } catch (error) {
          return res.status(409).json({ error: 'Join request already consumed', message: error.message });
        }

        console.log('\nStoring node...');
        // A node earns 'active' (routable) only after passing the 24h stability
        // trial, so it registers into 'trial' first and the trial scheduler
        // graduates it. Gated by NODE_TRIAL_ENABLED so the feature ships dark until
        // the scheduler + node-side probe handlers are live; FREE_MODE dev skips it.
        const registrationStatus =
          process.env.NODE_TRIAL_ENABLED === 'true' && process.env.FREE_MODE !== 'true'
            ? 'trial'
            : 'active';

        NodeStore.upsertNode({
          id:               nodeId,
          pubkey_secp256k1: pubkeySecp256k1,
          pubkey_ed25519:   pubkeyEd25519,
          region,
          contact,
          capabilities: {
            forward_proxy:    declaredCapabilities?.forward_proxy  ?? false,
            reverse_proxy:    declaredCapabilities?.reverse_proxy  ?? false,
            websockets:       declaredCapabilities?.websockets      ?? false,
            tunnels:          declaredCapabilities?.tunnels         ?? false,
            ip_leasing:       declaredCapabilities?.ip_leasing      ?? false,
            benchmark_score:  benchmarkScore,
            benchmark_details: benchmarkDetails,
            // cpu_performance now carries the admission capacity (stable sustained
            // 16KB req/s) — the honest "what can this node serve" figure. The full
            // verdict (floor, effective_cores, blockers) lives in benchmark_details
            // .admission. Old-format fallbacks stay for nodes evaluated pre-switch.
            cpu_performance:  benchmarkDetails?.admission?.capacity_req_s ?? benchmarkDetails?.benchmark_cpu?.bytes_per_second ?? benchmarkDetails?.benchmark_cpu?.hashes_per_second ?? null,
            crypto_performance: benchmarkDetails?.benchmark_crypto?.total_bytes_per_second ?? null,
            memory_score:     benchmarkDetails?.admission?.effective_cores ?? benchmarkDetails?.benchmark_memory?.bytes_per_second ?? benchmarkDetails?.benchmark_memory_pressure?.allocated_mb ?? null,
            ipv4,
            ipv6:             ipv6 || null,
            port,
            geo:              geoRegion,
          },
          evm_address,
          solana_address,
          icp_address,
          status: registrationStatus,
        });

        NodeStore.setDomain(nodeId, subdomain);
        console.log(' Node stored');

        observeNode(nodeId, ipv4, ipv6 || null).catch((err) =>
          console.error(`[Observer] Initial observation failed for ${nodeId}:`, err),
        );

        // Pin the orchestrator's ticket-verification key into the join response so
        // the node trusts it from registration onward (not whatever is served at
        // request time). Null when no signing key is configured (e.g. FREE_MODE dev).
        const pin = orchestratorPinForJoin();
        if (!pin.orchestrator_pubkey) {
          console.warn('[Nodes] Orchestrator signing key unset — node registering without a pinned key');
        }

        const processingTime = Date.now() - startTime;
        console.log(`\n✅ Node registered in ${processingTime}ms — price paid: $${paidPrice}\n`);

        res.json({
          success:            true,
          node_id:            nodeId,
          domain:             subdomain,
          connect_url:        connectUrl,
          ipv6:               ipv6 || null,
          ipv4,
          port,
          region,
          geo:                geoRegion,
          status:             registrationStatus,
          benchmark_score:    benchmarkScore,
          orchestrator_pubkey: pin.orchestrator_pubkey,
          price_paid:         paidPrice,
          join_request_id:    consumedJoin?.id ?? null,
          processing_time_ms: processingTime,
          next_steps: [
            registrationStatus === 'trial'
              ? `On trial: keep the control tunnel up 24/7 — the orchestrator is measuring stability before it routes real traffic to you`
              : `Keep the outbound control tunnel connected at /node/tunnel (heartbeats ride it automatically)`,
            `Clients connect to ${connectUrl}`,
            `Monitor status at /node/status/${nodeId}`,
          ],
        });
      } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed', message: error.message });
      }
    },
  );

  app.get('/node/status/:node_id', (req, res) => {
    try {
      const node = NodeStore.getNode(req.params.node_id);
      if (!node) return res.status(404).json({ error: 'Node not found' });

      res.json(publicNode(node));
    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({ error: 'Failed to get status', message: error.message });
    }
  });

  app.get('/nodes', (req, res) => {
    try {
      const nodes = NodeStore.listNodes();
      res.json({
        total:              nodes.length,
        current_join_price: calculateJoinPrice(),
        nodes: nodes.map(publicNode),
      });
    } catch (error) {
      console.error('List nodes error:', error);
      res.status(500).json({ error: 'Failed to list nodes', message: error.message });
    }
  });

  app.delete('/node/:node_id', requireLoopback, (req, res) => {
    try {
      const { node_id } = req.params;
      const deleted = NodeStore.deleteNode(node_id);
      if (!deleted) return res.status(404).json({ error: 'Node not found', node_id });
      console.log(`[Nodes] Deleted node: ${node_id}`);
      res.json({ deleted: true, node_id });
    } catch (error) {
      console.error('Delete node error:', error);
      res.status(500).json({ error: 'Failed to delete node', message: error.message });
    }
  });

  return {
    getStats: () => ({
      total_nodes:        NodeStore.listNodes().length,
      current_join_price: calculateJoinPrice(),
    }),
  };
}
