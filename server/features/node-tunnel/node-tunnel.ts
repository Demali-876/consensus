import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { Express } from 'express';
import type { Server } from 'http';
import NodeStore from '../../data/node_store.js';
import { log } from '../../utils/log.ts';
import { FRAME_TYPE, type FrameType } from './frames.ts';
import { acceptClientHandshake, createHandshakeReject, decodeHandshakeMessage, encodeHandshakeMessage } from './handshake.ts';
import { MESSAGE_TYPE, createErrorMessage, decodeMessage, encodeMessage, nowSeconds, type EvalAction, type EvalResponseMessage, type HelloMessage, type ProxyResponseMessage, type TunnelMessage, type UpdateReadyMessage } from './messages.ts';
import { openFrame, sealFrame, type SecureSession } from './secure-channel.ts';
import { speedtestUrl } from './speedtest-target.ts';
import { deriveAdmission, type AdmissionVerdict } from './admission.ts';
import { verifyIntegrityPayload, type IntegrityPayload } from '../../utils/integrity.ts';

interface PendingTunnelRequest {
  kind: 'proxy' | 'update' | 'probe';
  resolve: (message: TunnelMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TunnelStream {
  streamId: string;
  onData: (data: Buffer) => void;
  onClose: (reason?: string) => void;
}

interface NodeTunnelSession {
  id: string;
  mode: 'eval' | 'control';
  ws: WebSocket;
  secure: SecureSession;
  sendSequence: bigint;
  lastReceiveSequence: bigint;
  nodeId?: string;
  candidateId?: string;
  publicKeyPem?: string;
  // The Ed25519 identity PROVEN in the tunnel handshake (acceptClientHandshake
  // verified init.node_public_key_pem). Immutable — unlike publicKeyPem, which
  // handleHello overwrites with a self-declared value. Security-critical anchors
  // (integrity verification, the join mint) MUST use this, not publicKeyPem.
  verifiedPublicKeyPem?: string;
  // The node_id PROVEN at a control handshake (verifyRegisteredControlIdentity
  // bound init.node_id to the verified key). Immutable — heartbeats and routing
  // bind to this, never a self-declared message.node_id. Undefined for eval
  // sessions (candidates have no node_id yet).
  verifiedNodeId?: string;
  version?: string;
  activeRequests: number;
  activeStreams: number;
  update?: {
    id: string;
    state: 'preparing' | 'ready' | 'draining' | 'updating' | 'failed';
    targetVersion: string;
    artifactPath?: string;
    sha256?: string;
    error?: string;
    updatedAt: number;
  };
  connectedAt: number;
  lastSeenAt: number;
  pending: Map<string, PendingTunnelRequest>;
  streams: Map<string, TunnelStream>;
  eval?: {
    status: 'pending' | 'passed' | 'failed';
    requested: EvalAction[];
    results: Partial<Record<EvalAction, unknown>>;
    errors: string[];
    joinRequest?: {
      id: string;
      nonce: string;
      alg: string;
      expires_at: number;
    };
    startedAt: number;
    completedAt?: number;
    // In-flight eval requests keyed by request id (EVAL_REQUEST.id ===
    // EVAL_RESPONSE.reply_to). handleEvalResponse resolves the waiter with the
    // response message. Id-keyed (not action-keyed) so the same action can be
    // sent repeatedly and concurrently — the network batteries rely on this.
    pending?: Map<string, (message: EvalResponseMessage) => void>;
    // Orchestrator-timed network measurements (tunnel echo + node speed test).
    // Collected here; folded into scoring under task 7.
    network?: NetworkEvalResult;
  };
}

type EvalJoinRequest = NonNullable<NonNullable<NodeTunnelSession['eval']>['joinRequest']>;
type RouterLike = {
  getNodeLoad?(nodeId: string): { requests: number; sessions: number; total: number };
};

const sessions = new Map<string, NodeTunnelSession>();
const byNodeId = new Map<string, string>();
// Optional stability-trial hooks, wired via the returned handle's setTrialListeners
// (only when NODE_TRIAL_ENABLED). No-ops while null, so a disabled trial costs
// nothing on the hot tunnel paths.
let trialListeners: {
  onConnect: (nodeId: string) => void;
  onHeartbeat: (nodeId: string) => void;
  onDisconnect: (nodeId: string) => void;
} | null = null;
// System sanity gates (not CPU benchmarking — basic capability floors that
// survive the switch to the composite/sustained admission model). The CPU gate
// itself lives in admission.ts (stable sustained 16KB req/s).
const EVAL_MIN_SYSTEM_MEMORY_MB = 512;
const EVAL_MAX_EVENT_LOOP_P99_NS = 50_000_000;
// A short sustained-bench sample driven over the control tunnel during the trial
// (thermal / oversubscription check). Kept brief — the node earns nothing during
// the trial, so we don't cook its CPU.
const TRIAL_SUSTAINED_MS = 10_000;
// Sustained window the server asks the node to hold during eval. 30s = 6×5s
// windows, enough to read early-vs-late throttle and a conservative floor. The
// 24h stability trial (task #10) is the long-run authority; this is the gate.
const SUSTAINED_EVAL_MS = 30_000;
// Extra head-room over the sustained window for warmup + the sanity round-trip
// so a valid run never trips the per-action timeout.
const SUSTAINED_TIMEOUT_MARGIN_MS = 15_000;
// Per-action ceiling for the serialized eval. The node's benchmark suites run
// ~1-2s each; 30s tolerates a slow-but-valid machine while bounding a node that
// never answers so the eval can't hang the session forever.
const EVAL_ACTION_TIMEOUT_MS = 30_000;
// Network-eval actions (echo/speedtest) are I/O, not compute — a shorter ceiling
// keeps a dead speedtest target from stalling the eval (see the warmup-skip in
// runSpeedBattery). The node's own fetch timeout is 15s.
const NETWORK_ACTION_TIMEOUT_MS = 20_000;
const ECHO_SIZES_BYTES = [1024, 16384, 262144];
const SPEEDTEST_SIZE_BYTES = 16384;
const SPEEDTEST_SEQUENTIAL_COUNT = 6;
const SPEEDTEST_CONCURRENCY = 6;

interface EchoProbe {
  size_bytes: number;
  ok: boolean;
  rtt_ms: number;
  // Round-trip (payload traverses both ways) throughput.
  throughput_mbps: number;
}

interface SpeedProbe {
  ok: boolean;
  status: number | null;
  rtt_ms: number;
  bytes: number;
  node_ms: number | null;
}

interface NetworkEvalResult {
  echo: EchoProbe[];
  echo_rtt_ms_p50: number | null;
  speed: {
    target_url: string;
    size_bytes: number;
    count: number;
    rtt_ms_p50: number | null;
    rtt_ms_p95: number | null;
    node_ms_p50: number | null;
    success_rate: number;
    samples: SpeedProbe[];
    skipped?: string;
  } | null;
  concurrency: {
    target_url: string;
    size_bytes: number;
    workers: number;
    batch_ms: number;
    success_rate: number;
    rtt_ms_p95: number | null;
    skipped?: string;
  } | null;
}

interface EvalActionOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  // Orchestrator-measured round-trip in milliseconds — the authoritative timing.
  rttMs: number;
}

// Recent-eval ring buffer for observability. Eval sessions are ephemeral (the
// live state vanishes when the candidate disconnects), so finalizeEval snapshots
// each completed eval here — score, errors, and the orchestrator-timed network
// block — for the loopback-only GET /node/tunnel/eval/recent debug route. This
// is how a real eval's numbers are read after the fact (and how task-7 gate
// thresholds get calibrated). In-memory only; capped.
interface EvalRecord {
  session_id: string;
  candidate_id: string | null;
  node_id: string | null;
  status: 'passed' | 'failed';
  score: number;
  // The admission verdict (stable sustained 16KB capacity + floor + blockers) —
  // the real ranking/gate data, distinct from the 0-100 health `score`.
  admission: AdmissionVerdict | null;
  // Whether the node's signed integrity/manifest payload verified against the
  // handshake-proven identity (+ the required release, when one is set).
  integrity: { ok: boolean; reason?: string } | null;
  errors: string[];
  started_at: number;
  completed_at: number;
  duration_ms: number;
  network: NetworkEvalResult | null;
}

const RECENT_EVAL_LIMIT = 10;
const recentEvals: EvalRecord[] = [];

function recordEvalResult(
  session: NodeTunnelSession,
  score: number,
  admission: AdmissionVerdict | null,
  integrity: { ok: boolean; reason?: string } | null
): void {
  if (!session.eval) return;
  const startedAt = session.eval.startedAt;
  const completedAt = session.eval.completedAt ?? Date.now();
  recentEvals.unshift({
    session_id: session.id,
    candidate_id: session.candidateId ?? null,
    node_id: session.nodeId ?? null,
    status: session.eval.status === 'passed' ? 'passed' : 'failed',
    score,
    admission,
    integrity,
    errors: [...session.eval.errors],
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: completedAt - startedAt,
    network: session.eval.network ?? null,
  });
  if (recentEvals.length > RECENT_EVAL_LIMIT) recentEvals.length = RECENT_EVAL_LIMIT;
}

// Router-directed node updates are disabled unless
// CONSENSUS_NODE_AUTO_UPDATES=true. When enabled, the scheduler picks one idle
// outdated control session at a time, prepares the artifact on the node, then
// applies after the router and tunnel both report no active work.
export function registerNodeTunnel(app: Express, server: Server, options: { router?: RouterLike } = {}) {
  log.info('node-tunnel', 'registered', {
    auto_updates: process.env.CONSENSUS_NODE_AUTO_UPDATES === 'true',
  });

  app.get('/node/tunnel/stats', (_req, res) => {
    res.json(getStats());
  });

  // Loopback-only: the last few completed evals, with the full orchestrator-timed
  // network block. Run `bun run eval` on a candidate, then curl this on the Pi to
  // read the real numbers. Also the source for task-7 threshold calibration.
  app.get('/node/tunnel/eval/recent', requireLoopback, (_req, res) => {
    res.json({ count: recentEvals.length, limit: RECENT_EVAL_LIMIT, evals: recentEvals });
  });

  app.post('/node/tunnel/proxy/:node_id', requireLoopback, async (req, res) => {
    const session = getControlSession(req.params.node_id);
    if (!session) return res.status(404).json({ error: 'Control tunnel not connected' });

    const body = req.body ?? {};
    if (!body.target_url) return res.status(400).json({ error: 'Missing target_url' });

    try {
      log.info('node-tunnel', 'proxy-request', {
        node_id: req.params.node_id,
        session_id: session.id,
        method: String(body.method ?? 'GET').toUpperCase(),
        target_url: sanitizeUrl(String(body.target_url)),
      });
      const response = await requestProxy(session, {
        target_url: String(body.target_url),
        method: String(body.method ?? 'GET').toUpperCase(),
        headers: normalizeHeaders(body.headers),
        body: typeof body.body === 'string' ? body.body : body.body == null ? undefined : JSON.stringify(body.body),
        body_encoding: 'utf8',
      });
      log.info('node-tunnel', 'proxy-response', {
        node_id: req.params.node_id,
        session_id: session.id,
        status: response.status,
      });

      res.status(response.status).json({
        status: response.status,
        statusText: response.status_text ?? '',
        headers: response.headers ?? {},
        data: decodeMessageBody(response.body, response.body_encoding),
      });
    } catch (error) {
      log.error('node-tunnel', 'proxy-failed', {
        node_id: req.params.node_id,
        session_id: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        error: 'Node proxy command failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/node/tunnel/update/:node_id/prepare', requireLoopback, async (req, res) => {
    try {
      const manifest = req.body?.manifest ?? NodeStore.getRequiredManifest()?.manifest;
      if (!manifest) return res.status(404).json({ error: 'No update manifest available' });
      log.info('node-update', 'manual-prepare-request', {
        node_id: req.params.node_id,
        target_version: typeof manifest.version === 'string' ? manifest.version : null,
      });
      const ready = await prepareNodeUpdate(req.params.node_id, manifest);
      res.json({ ok: true, ready });
    } catch (error) {
      log.error('node-update', 'manual-prepare-failed', {
        node_id: req.params.node_id,
        message: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Update prepare failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/node/tunnel/update/:node_id/apply', requireLoopback, async (req, res) => {
    try {
      log.info('node-update', 'manual-apply-request', {
        node_id: req.params.node_id,
        update_id: req.body?.update_id ?? null,
        restart_after_ms: Number(req.body?.restart_after_ms ?? 1_000),
        force: Boolean(req.body?.force),
      });
      const result = await applyNodeUpdate(req.params.node_id, {
        updateId: req.body?.update_id,
        restartAfterMs: Number(req.body?.restart_after_ms ?? 1_000),
        force: Boolean(req.body?.force),
      });
      res.json({ ok: true, result });
    } catch (error) {
      log.error('node-update', 'manual-apply-failed', {
        node_id: req.params.node_id,
        update_id: req.body?.update_id ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Update apply failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  const scheduler = startUpdateScheduler(options.router);

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/node/tunnel') return;

    log.info('node-tunnel', 'upgrade-received', {
      remote: req.socket.remoteAddress,
      forwarded_for: req.headers['x-forwarded-for'] ?? null,
      user_agent: req.headers['user-agent'] ?? null,
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let session: NodeTunnelSession | null = null;
    let handshakeComplete = false;

    log.info('node-tunnel', 'websocket-open', {});

    ws.once('message', (data: WebSocket.RawData) => {
      void handleHandshake(ws, toBuffer(data))
        .then((created) => {
          session = created;
          handshakeComplete = true;
          sessions.set(created.id, created);
          if (created.nodeId) byNodeId.set(created.nodeId, created.id);
          if (created.mode === 'control' && created.verifiedNodeId && trialListeners) {
            try {
              trialListeners.onConnect(created.verifiedNodeId);
            } catch (error) {
              log.error('node-tunnel', 'trial-onconnect-failed', {
                node_id: created.verifiedNodeId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          ws.on('message', (raw: WebSocket.RawData) => {
            if (!session) return;
            void handleEncryptedMessage(session, toBuffer(raw)).catch((error) => {
              log.error('node-tunnel', 'encrypted-message-failed', {
                session_id: session?.id,
                node_id: session?.nodeId ?? null,
                mode: session?.mode,
                message: error instanceof Error ? error.message : String(error),
              });
              void sendEncrypted(session!, createErrorMessage({
                code: 'message_failed',
                message: error instanceof Error ? error.message : String(error),
              })).catch(() => undefined);
            });
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.error('node-tunnel', 'handshake-failed', { message });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeHandshakeMessage(createHandshakeReject('handshake_failed', message)));
            ws.close(1008, 'handshake_failed');
          }
        });
    });

    ws.on('close', (code, reason) => {
      if (!handshakeComplete || !session) {
        log.warn('node-tunnel', 'websocket-closed-before-handshake', {
          code,
          reason: reason.toString() || null,
        });
        return;
      }
      sessions.delete(session.id);
      if (session.nodeId && byNodeId.get(session.nodeId) === session.id) {
        byNodeId.delete(session.nodeId);
      }
      closeActiveStreams(session, 'node tunnel disconnected');
      rejectPendingProxyRequests(session, new Error(`Node tunnel disconnected: ${session.nodeId ?? session.id}`));
      if (session.mode === 'control' && session.verifiedNodeId && trialListeners) {
        try {
          trialListeners.onDisconnect(session.verifiedNodeId);
        } catch {
          /* best-effort */
        }
      }
      if (session.nodeId && session.update?.state === 'updating') {
        NodeStore.setNodeUpdateState(session.nodeId, 'updating', {
          update_id: session.update.id,
          target_version: session.update.targetVersion,
        });
      }
      log.warn('node-tunnel', 'disconnected', {
        session_id: session.id,
        mode: session.mode,
        node_id: session.nodeId ?? null,
        candidate_id: session.candidateId ?? null,
        version: session.version ?? null,
        code,
        reason: reason.toString() || null,
        connected_for_ms: Date.now() - session.connectedAt,
        last_seen_ms_ago: Date.now() - session.lastSeenAt,
        active_requests: session.activeRequests,
        active_streams: session.activeStreams,
        update_state: session.update?.state ?? null,
      });
    });

    ws.on('error', (error: Error) => {
      log.error('node-tunnel', 'websocket-error', {
        session_id: session?.id ?? null,
        node_id: session?.nodeId ?? null,
        message: error.message,
      });
    });
  });

  return {
    getStats,
    requestProxy: (
      nodeId: string,
      input: {
        target_url: string;
        method: string;
        headers?: Record<string, string>;
        body?: string;
        body_encoding?: 'utf8' | 'base64';
      },
    ) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return requestProxy(session, input);
    },
    attachProxySession: (nodeId: string, clientWs: WebSocket) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return attachProxySession(session, clientWs);
    },
    attachDataPlaneSession: (nodeId: string, clientWs: WebSocket) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return attachDataPlaneSession(session, clientWs);
    },
    attachRawTunnelStream: (
      nodeId: string,
      input: {
        targetHost: string;
        targetPort: number;
        initialData?: Buffer;
        onData: (data: Buffer) => void;
        onEnd: () => void;
        onError: (error: Error) => void;
      },
    ) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return attachRawTunnelStream(session, input);
    },
    attachTunnelOwnerSession: (
      nodeId: string,
      input: {
        tunnelId: string;
        ownerWs: WebSocket;
      },
    ) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return attachTunnelOwnerSession(session, input);
    },
    attachPublicTunnelStream: (
      nodeId: string,
      input: {
        tunnelId: string;
        initialData?: Buffer;
        onData: (data: Buffer) => void;
        onEnd: () => void;
        onError: (error: Error) => void;
      },
    ) => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      return attachPublicTunnelStream(session, input);
    },
    prepareNodeUpdate,
    applyNodeUpdate,
    stopUpdateScheduler: () => scheduler?.stop(),
    getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    getNodeSession: (nodeId: string) => {
      const sessionId = byNodeId.get(nodeId);
      return sessionId ? sessions.get(sessionId) ?? null : null;
    },
    // Stability-trial integration (see features/nodes/trial-manager.ts). Wired by
    // server.js only when NODE_TRIAL_ENABLED; unset = zero overhead.
    setTrialListeners: (listeners: {
      onConnect: (nodeId: string) => void;
      onHeartbeat: (nodeId: string) => void;
      onDisconnect: (nodeId: string) => void;
    }) => {
      trialListeners = listeners;
    },
    isControlConnected: (nodeId: string) => getControlSession(nodeId) !== null,
    // Trial probes the fetch path can't cover (see trial-manager.ts): an occasional
    // sustained-bench sample (thermal) and an integrity re-attestation (hard gate).
    // Integrity is verified here, where the handshake-proven key lives.
    runTrialSustainedProbe: async (nodeId: string): Promise<{ capacity_req_s: number | null }> => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      const res = await requestProbe(session, 'benchmark_sustained', { duration_ms: TRIAL_SUSTAINED_MS }, TRIAL_SUSTAINED_MS + 20_000);
      const result = res.result as { node_rps_mean?: number } | undefined;
      return { capacity_req_s: typeof result?.node_rps_mean === 'number' ? result.node_rps_mean : null };
    },
    reattestNodeIntegrity: async (nodeId: string): Promise<{ ok: boolean; reason?: string }> => {
      const session = getControlSession(nodeId);
      if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
      const res = await requestProbe(session, 'integrity', {});
      return verifyProbeIntegrity(session, res.result as IntegrityPayload | undefined);
    },
  };
}

async function handleHandshake(ws: WebSocket, raw: Buffer): Promise<NodeTunnelSession> {
  const init = decodeHandshakeMessage(raw);
  if (init.type !== 'handshake_init') {
    throw new Error(`Unexpected first node tunnel message: ${init.type}`);
  }

  log.info('node-tunnel', 'handshake-init', {
    mode: init.mode,
    node_id: init.node_id ?? null,
    candidate_id: init.candidate_id ?? null,
    release_version: init.release_version ?? null,
    timestamp: init.timestamp,
  });
  const accepted = await acceptClientHandshake(init);
  if (init.mode === 'control') {
    verifyRegisteredControlIdentity(init.node_id, init.node_public_key_pem);
  }
  const session: NodeTunnelSession = {
    id: accepted.session.sessionId,
    mode: init.mode,
    ws,
    secure: accepted.session,
    sendSequence: 0n,
    lastReceiveSequence: -1n,
    nodeId: init.node_id,
    candidateId: init.candidate_id,
    publicKeyPem: init.node_public_key_pem,
    // Handshake-proven identity (acceptClientHandshake verified this above; for
    // control, verifyRegisteredControlIdentity bound init.node_id to that key).
    verifiedPublicKeyPem: init.node_public_key_pem,
    verifiedNodeId: init.node_id,
    version: init.release_version,
    activeRequests: 0,
    activeStreams: 0,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    pending: new Map(),
    streams: new Map(),
  };

  ws.send(encodeHandshakeMessage(accepted.message));
  log.info('node-tunnel', 'handshake-accepted', {
    session_id: session.id,
    mode: init.mode,
    node_id: init.node_id ?? null,
    candidate_id: init.candidate_id ?? null,
    release_version: init.release_version ?? null,
  });
  return session;
}

function verifyRegisteredControlIdentity(nodeId: string | undefined, publicKeyPem: string): void {
  if (!nodeId) throw new Error('Control tunnel requires node_id');

  const node = NodeStore.getNode(nodeId);
  if (!node) throw new Error(`Registered node not found: ${nodeId}`);
  // A node on trial (or quarantined) holds a control tunnel so the orchestrator can
  // probe it, but the Router still refuses it real traffic (it only routes
  // status === 'active'). That split — "may connect and be probed" vs "may serve
  // users" — is what lets the 24h trial and post-join monitoring run: a quarantined
  // node keeps its tunnel so it can be probed back to health. Any other status
  // (provisioning/failed) may not connect.
  if (node.status !== 'active' && node.status !== 'trial' && node.status !== 'quarantined') {
    throw new Error(`Registered node is not eligible to connect: ${nodeId} (status ${node.status})`);
  }
  if (!node.pubkey_ed25519) throw new Error(`Registered node has no Ed25519 key: ${nodeId}`);

  const presented = crypto.createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' });
  const registered = Buffer.from(node.pubkey_ed25519);
  if (presented.length !== registered.length || !crypto.timingSafeEqual(Buffer.from(presented), registered)) {
    throw new Error(`Control tunnel key mismatch for node: ${nodeId}`);
  }
  log.info('node-tunnel', 'control-identity-verified', {
    node_id: nodeId,
    region: node.region,
    domain: node.domain ?? null,
  });
}

async function handleEncryptedMessage(session: NodeTunnelSession, raw: Buffer): Promise<void> {
  const opened = openFrame(session.secure.receiveKey, raw);
  if (opened.frame.sequence <= session.lastReceiveSequence) {
    throw new Error('Replay or out-of-order node tunnel frame rejected');
  }

  session.lastReceiveSequence = opened.frame.sequence;
  session.lastSeenAt = Date.now();

  if (opened.frame.type === FRAME_TYPE.PING) {
    await sendEncrypted(session, {
    type: MESSAGE_TYPE.PONG,
    timestamp: nowSeconds(),
    }, FRAME_TYPE.PONG);
    return;
  }

  if (opened.frame.type === FRAME_TYPE.PONG) return;
  if (opened.frame.type === FRAME_TYPE.CLOSE) {
    session.ws.close(1000, 'remote close');
    return;
  }

  const message = decodeMessage(opened.plaintext);
  if (message.type === MESSAGE_TYPE.HELLO) {
    await handleHello(session, message);
    return;
  }
  if (message.type === MESSAGE_TYPE.HEARTBEAT) {
    // Heartbeats ride only the authenticated tunnel (the unauthenticated HTTP
    // /node/heartbeat route was removed). Bind to the handshake-PROVEN node_id,
    // never the message's self-declared one — otherwise an authenticated node
    // could record liveness and hijack routing (byNodeId) as a DIFFERENT node.
    const nodeId = session.verifiedNodeId;
    if (!nodeId) {
      log.warn('node-tunnel', 'heartbeat-unverified-session', { session_id: session.id });
      return;
    }
    if (message.node_id && message.node_id !== nodeId) {
      log.warn('node-tunnel', 'heartbeat-node-id-mismatch', {
        session_id: session.id,
        verified_node_id: nodeId,
        claimed_node_id: message.node_id,
      });
    }
    session.activeRequests = message.active_requests ?? 0;
    session.activeStreams = message.active_streams ?? 0;
    byNodeId.set(nodeId, session.id);
    try {
      NodeStore.heartbeat(nodeId, {
        rps: message.active_requests ?? null,
        p95_ms: null,
        version: session.version ?? null,
      });
    } catch (error) {
      log.error('node-tunnel', 'heartbeat-store-failed', {
        node_id: nodeId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    clearCompletedUpdateState(nodeId, session.version, 'heartbeat');
    if (trialListeners) {
      try {
        trialListeners.onHeartbeat(nodeId);
      } catch (error) {
        log.error('node-tunnel', 'trial-onheartbeat-failed', {
          node_id: nodeId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return;
  }
  if (message.type === MESSAGE_TYPE.EVAL_RESPONSE) {
    // Eval mode drives the onboarding battery (session.eval.pending). In control
    // mode the same message type carries a trial probe's result, awaited through
    // the generic pending map.
    if (session.mode === 'eval') {
      handleEvalResponse(session, message);
    } else {
      resolvePending(session, message);
    }
    return;
  }
  if (message.type === MESSAGE_TYPE.PROXY_RESPONSE || message.type === MESSAGE_TYPE.ERROR || message.type === MESSAGE_TYPE.ACK) {
    resolvePending(session, message);
    return;
  }
  if (message.type === MESSAGE_TYPE.UPDATE_READY) {
    log.info('node-update', 'ready', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      update_id: message.update_id,
      current_version: message.current_version,
      target_version: message.target_version,
      sha256: message.sha256,
    });
    session.update = {
      id: message.update_id,
      state: 'ready',
      targetVersion: message.target_version,
      artifactPath: message.artifact_path,
      sha256: message.sha256,
      updatedAt: Date.now(),
    };
    if (session.nodeId) {
      NodeStore.setNodeUpdateState(session.nodeId, 'ready', {
        update_id: message.update_id,
        target_version: message.target_version,
      });
    }
    resolvePending(session, message);
    return;
  }
  if (message.type === MESSAGE_TYPE.UPDATE_FAILED) {
    log.error('node-update', 'failed', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      update_id: message.update_id,
      code: message.code,
      message: message.message,
    });
    session.update = {
      id: message.update_id,
      state: 'failed',
      targetVersion: session.update?.targetVersion ?? '',
      error: message.message,
      updatedAt: Date.now(),
    };
    if (session.nodeId) {
      NodeStore.setNodeUpdateState(session.nodeId, 'failed', {
        update_id: message.update_id,
        target_version: session.update.targetVersion,
        reason: message.message,
      });
    }
    resolvePending(session, message);
    return;
  }
  if (message.type === MESSAGE_TYPE.STREAM_DATA) {
    const stream = session.streams.get(message.stream_id);
    if (stream) stream.onData(Buffer.from(message.data, 'base64'));
    else log.warn('node-tunnel', 'stream-data-missing-stream', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: message.stream_id,
      bytes_base64: message.data.length,
    });
    return;
  }
  if (message.type === MESSAGE_TYPE.STREAM_CLOSE) {
    const stream = session.streams.get(message.stream_id);
    if (stream) {
      session.streams.delete(message.stream_id);
      log.info('node-tunnel', 'stream-close-received', {
        session_id: session.id,
        node_id: session.nodeId ?? null,
        stream_id: message.stream_id,
        reason: message.reason ?? null,
      });
      stream.onClose(message.reason);
    }
    else log.warn('node-tunnel', 'stream-close-missing-stream', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: message.stream_id,
      reason: message.reason ?? null,
    });
    return;
  }
}

// Compare two PEM public keys by their DER SPKI encoding (formatting-agnostic,
// timing-safe). Returns false if either fails to parse.
function samePublicKey(a: string, b: string): boolean {
  try {
    const da = crypto.createPublicKey(a).export({ format: 'der', type: 'spki' });
    const db = crypto.createPublicKey(b).export({ format: 'der', type: 'spki' });
    return da.length === db.length && crypto.timingSafeEqual(da, db);
  } catch {
    return false;
  }
}

async function handleHello(session: NodeTunnelSession, message: HelloMessage): Promise<void> {
  session.mode = message.mode;
  session.nodeId = message.node_id;
  session.candidateId = message.candidate_id;
  // The HELLO rides the authenticated secure channel, but its public_key_pem is a
  // self-declared field; the handshake already PROVED the identity. Flag a
  // mismatch for visibility — security-critical paths use verifiedPublicKeyPem,
  // never this HELLO value. (Hard rejection is task #9: bind eval→join→control.)
  if (
    message.public_key_pem &&
    session.verifiedPublicKeyPem &&
    !samePublicKey(message.public_key_pem, session.verifiedPublicKeyPem)
  ) {
    log.warn('node-tunnel', 'hello-key-mismatch', {
      session_id: session.id,
      candidate_id: message.candidate_id ?? null,
      node_id: message.node_id ?? null,
    });
  }
  session.publicKeyPem = message.public_key_pem;
  session.version = message.version;
  if (session.nodeId) byNodeId.set(session.nodeId, session.id);

  log.info('node-tunnel', 'hello', {
    session_id: session.id,
    mode: message.mode,
    node_id: message.node_id ?? null,
    candidate_id: message.candidate_id ?? null,
    version: message.version ?? null,
  });
  if (session.nodeId) clearCompletedUpdateState(session.nodeId, session.version, 'hello');
  await sendEncrypted(session, {
    type: MESSAGE_TYPE.READY,
    timestamp: nowSeconds(),
    session_id: session.id,
    mode: session.mode,
  });

  if (session.mode === 'eval') {
    log.info('node-eval', 'starting', {
      session_id: session.id,
      candidate_id: session.candidateId ?? null,
      version: session.version ?? null,
    });
    await startEval(session);
  }
}

async function startEval(session: NodeTunnelSession): Promise<void> {
  // The admission battery. capabilities/integrity identify the node; system +
  // event_loop are basic sanity; composite/sustained/multicore are the bench-cpu
  // model the network now admits on (replacing the old cpu/crypto/memory
  // throughput probes). Order matters: sustained runs its 30s window on an
  // otherwise-idle node, and multicore (all-core load) runs AFTER it so all-core
  // heat cannot pre-throttle the single-core steady-state read.
  const actions: EvalAction[] = [
    'capabilities',
    'integrity',
    'benchmark_system',
    'benchmark_event_loop',
    'benchmark_composite',
    'benchmark_sustained',
    'benchmark_multicore',
  ];
  session.eval = {
    status: 'pending',
    requested: actions,
    results: {},
    errors: [],
    startedAt: Date.now(),
    pending: new Map(),
  };

  // Serialize the compute eval: send one action, await its response (or time
  // out), then send the next. Firing all requests at once made the node run its
  // CPU, crypto, and memory benchmarks concurrently, so every measurement was
  // contended — and those are the numbers the network judges hardware on. One
  // action in flight at a time gives each benchmark an uncontended core.
  // Safe against deadlock: ws 'message' events are independent callbacks (see
  // the ws.on('message') dispatch), so the EVAL_RESPONSE that unblocks each
  // await is still delivered while this loop is suspended.
  for (const action of actions) {
    if (session.ws.readyState !== WebSocket.OPEN) {
      session.eval.errors.push(`${action}: control channel closed before eval completed`);
      break;
    }
    const outcome = await sendEvalAction(session, action, evalParams(action), evalActionTimeout(action));
    if (outcome.ok) {
      session.eval.results[action] = outcome.result;
    } else if (!session.eval.errors.some((error) => error.startsWith(`${action}:`))) {
      session.eval.errors.push(`${action}: ${outcome.error ?? 'unknown error'}`);
    }
  }

  // Orchestrator-timed network eval: tunnel echo (isolates the channel) + node
  // speed test (real fetch capability). Additive and non-breaking for now —
  // results are collected into session.eval.network; scoring folds them in under
  // task 7, so a skipped/failed network phase does not fail the eval today.
  if (session.ws.readyState === WebSocket.OPEN) {
    try {
      session.eval.network = await runNetworkEval(session);
      log.info('node-eval', 'network-complete', {
        session_id: session.id,
        candidate_id: session.candidateId ?? null,
        echo_p50_ms: session.eval.network.echo_rtt_ms_p50,
        speed_p50_ms: session.eval.network.speed?.rtt_ms_p50 ?? null,
        speed_success: session.eval.network.speed?.success_rate ?? null,
        concurrency_success: session.eval.network.concurrency?.success_rate ?? null,
      });
    } catch (error) {
      log.error('node-eval', 'network-failed', {
        session_id: session.id,
        candidate_id: session.candidateId ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  finalizeEval(session);
}

// Send one eval action and resolve with the node's response plus the
// orchestrator-measured round-trip. Never rejects — a timeout or send failure
// resolves as { ok: false } so callers (serial loop and concurrent batteries)
// can treat every outcome uniformly.
function sendEvalAction(
  session: NodeTunnelSession,
  action: EvalAction,
  params?: Record<string, unknown>,
  timeoutMs: number = EVAL_ACTION_TIMEOUT_MS,
): Promise<EvalActionOutcome> {
  if (!session.eval || session.ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: 'control channel closed', rttMs: 0 });
  }

  const id = crypto.randomUUID();
  const startedAt = performance.now();
  const pending = session.eval.pending!;

  log.info('node-eval', 'request', {
    session_id: session.id,
    candidate_id: session.candidateId ?? null,
    action,
  });

  return new Promise<EvalActionOutcome>((resolve) => {
    const settle = (outcome: EvalActionOutcome): void => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      log.warn('node-eval', 'action-timeout', {
        session_id: session.id,
        candidate_id: session.candidateId ?? null,
        action,
      });
      settle({ ok: false, error: `timed out after ${timeoutMs}ms`, rttMs: performance.now() - startedAt });
    }, timeoutMs);

    pending.set(id, (message) => {
      settle({ ok: message.ok, result: message.result, error: message.error, rttMs: performance.now() - startedAt });
    });

    void sendEncrypted(session, {
      type: MESSAGE_TYPE.EVAL_REQUEST,
      id,
      timestamp: nowSeconds(),
      action,
      params,
    }).catch((error) => {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error), rttMs: performance.now() - startedAt });
    });
  });
}

async function runNetworkEval(session: NodeTunnelSession): Promise<NetworkEvalResult> {
  const echo = await runEchoBattery(session);
  const echoRtts = echo.filter((probe) => probe.ok).map((probe) => probe.rtt_ms);

  const speed = await runSpeedBattery(session);
  // Only probe concurrency if the sequential battery reached the target — no
  // point firing six parallel requests at a host we already know is unreachable.
  const concurrency = speed.skipped ? { ...emptyConcurrency(speed.target_url), skipped: speed.skipped } : await runConcurrencyBattery(session);

  return {
    echo,
    echo_rtt_ms_p50: percentileOrNull(echoRtts, 0.5),
    speed,
    concurrency,
  };
}

async function runEchoBattery(session: NodeTunnelSession): Promise<EchoProbe[]> {
  const probes: EchoProbe[] = [];
  for (const size of ECHO_SIZES_BYTES) {
    const payload = crypto.randomBytes(size).toString('base64');
    const nonce = crypto.randomUUID();
    const outcome = await sendEvalAction(session, 'tunnel_echo', { payload, nonce }, NETWORK_ACTION_TIMEOUT_MS);
    const result = outcome.result as { echo?: string; nonce?: string } | undefined;
    // Integrity: the echo must come back byte-identical with the matching nonce,
    // else the tunnel corrupted or misrouted it — not a valid throughput sample.
    const ok = outcome.ok && result?.echo === payload && result?.nonce === nonce;
    const throughputMbps = ok && outcome.rttMs > 0 ? (2 * size * 8) / (outcome.rttMs / 1000) / 1e6 : 0;
    probes.push({
      size_bytes: size,
      ok,
      rtt_ms: round2(outcome.rttMs),
      throughput_mbps: round2(throughputMbps),
    });
  }
  return probes;
}

async function runSpeedBattery(session: NodeTunnelSession): Promise<NonNullable<NetworkEvalResult['speed']>> {
  const targetUrl = speedtestUrl(SPEEDTEST_SIZE_BYTES);
  const base = {
    target_url: targetUrl,
    size_bytes: SPEEDTEST_SIZE_BYTES,
    count: 0,
    rtt_ms_p50: null,
    rtt_ms_p95: null,
    node_ms_p50: null,
    success_rate: 0,
    samples: [] as SpeedProbe[],
  };

  // Warmup probe: if the orchestrator target is unreachable from this node,
  // skip the battery rather than eat SPEEDTEST_SEQUENTIAL_COUNT timeouts.
  const warm = await sendEvalAction(session, 'speedtest_fetch', { target_url: targetUrl }, NETWORK_ACTION_TIMEOUT_MS);
  if (!warm.ok) {
    return { ...base, skipped: `target unreachable: ${warm.error ?? 'warmup probe failed'}` };
  }

  const samples: SpeedProbe[] = [toSpeedProbe(warm)];
  for (let i = 1; i < SPEEDTEST_SEQUENTIAL_COUNT; i++) {
    samples.push(toSpeedProbe(await sendEvalAction(session, 'speedtest_fetch', { target_url: targetUrl }, NETWORK_ACTION_TIMEOUT_MS)));
  }

  const okSamples = samples.filter((sample) => sample.ok);
  return {
    ...base,
    count: samples.length,
    rtt_ms_p50: percentileOrNull(okSamples.map((s) => s.rtt_ms), 0.5),
    rtt_ms_p95: percentileOrNull(okSamples.map((s) => s.rtt_ms), 0.95),
    node_ms_p50: percentileOrNull(okSamples.map((s) => s.node_ms ?? 0), 0.5),
    success_rate: samples.length ? okSamples.length / samples.length : 0,
    samples,
  };
}

async function runConcurrencyBattery(session: NodeTunnelSession): Promise<NonNullable<NetworkEvalResult['concurrency']>> {
  const targetUrl = speedtestUrl(SPEEDTEST_SIZE_BYTES);
  const startedAt = performance.now();
  // Fire all workers at once — id-keyed pending lets many of the same action be
  // in flight. This is I/O concurrency (node fetches), the intended behaviour;
  // it does not reintroduce the compute contention the serial loop fixed.
  const outcomes = await Promise.all(
    Array.from({ length: SPEEDTEST_CONCURRENCY }, () =>
      sendEvalAction(session, 'speedtest_fetch', { target_url: targetUrl }, NETWORK_ACTION_TIMEOUT_MS),
    ),
  );
  const batchMs = performance.now() - startedAt;
  const okOutcomes = outcomes.filter((outcome) => outcome.ok);

  return {
    target_url: targetUrl,
    size_bytes: SPEEDTEST_SIZE_BYTES,
    workers: SPEEDTEST_CONCURRENCY,
    batch_ms: round2(batchMs),
    success_rate: outcomes.length ? okOutcomes.length / outcomes.length : 0,
    rtt_ms_p95: percentileOrNull(okOutcomes.map((o) => o.rttMs), 0.95),
  };
}

function emptyConcurrency(targetUrl: string): NonNullable<NetworkEvalResult['concurrency']> {
  return {
    target_url: targetUrl,
    size_bytes: SPEEDTEST_SIZE_BYTES,
    workers: 0,
    batch_ms: 0,
    success_rate: 0,
    rtt_ms_p95: null,
  };
}

function toSpeedProbe(outcome: EvalActionOutcome): SpeedProbe {
  const result = outcome.result as { status?: number; bytes?: number; node_ms?: number } | undefined;
  return {
    ok: outcome.ok,
    status: typeof result?.status === 'number' ? result.status : null,
    rtt_ms: round2(outcome.rttMs),
    bytes: typeof result?.bytes === 'number' ? result.bytes : 0,
    node_ms: typeof result?.node_ms === 'number' ? result.node_ms : null,
  };
}

function percentileOrNull(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round2(sorted[index]);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function evalParams(action: EvalAction): Record<string, unknown> | undefined {
  // The server sets the sustained window; composite and multicore use the node's
  // own defaults (3 response sizes, powers-of-two worker counts).
  if (action === 'benchmark_sustained') return { duration_ms: SUSTAINED_EVAL_MS };
  return undefined;
}

// The sustained suite deliberately runs for SUSTAINED_EVAL_MS, far longer than a
// compute benchmark, so it needs a longer per-action ceiling than the default.
function evalActionTimeout(action: EvalAction): number {
  if (action === 'benchmark_sustained') return SUSTAINED_EVAL_MS + SUSTAINED_TIMEOUT_MARGIN_MS;
  return EVAL_ACTION_TIMEOUT_MS;
}

function handleEvalResponse(session: NodeTunnelSession, message: EvalResponseMessage): void {
  if (!session.eval) return;

  log.info('node-eval', 'response', {
    session_id: session.id,
    candidate_id: session.candidateId ?? null,
    action: message.action,
    ok: message.ok,
    error: message.error ?? null,
  });
  // Hand the response to the waiter that sent this request id. sendEvalAction
  // owns recording the result/error (via its returned outcome) and cleaning up
  // the map entry. A late response whose waiter already timed out finds no entry
  // and is dropped harmlessly.
  const waiter = session.eval.pending?.get(message.reply_to);
  if (waiter) waiter(message);
}

// Score the collected eval results and, on pass, mint + send the join request.
// Called once by startEval after every action has responded or timed out.
function finalizeEval(session: NodeTunnelSession): void {
  if (!session.eval || session.eval.completedAt) return;

  session.eval.completedAt = Date.now();
  const evalScore = scoreEvalResults(session.eval.results);
  session.eval.errors.push(...evalScore.errors);

  // Integrity: verify the node's signed manifest against the handshake-PROVEN
  // identity (not the HELLO-declared key) and the required release. A failure
  // blocks admission — this is what makes the self-reported benchmark numbers
  // trustworthy: only a node holding the proven identity, running an approved
  // build, is admitted.
  const integrity = verifyEvalIntegrity(session);
  if (!integrity.ok) session.eval.errors.push(`integrity: ${integrity.reason}`);

  session.eval.status = session.eval.errors.length === 0 ? 'passed' : 'failed';
  if (session.eval.status === 'passed' && session.verifiedPublicKeyPem) {
    // Mint the join against the PROVEN identity, so the admitted node is exactly
    // the one that handshook + passed integrity (not a HELLO-declared key).
    const joinRequest = createEvalJoinRequest(session.verifiedPublicKeyPem, evalScore);
    session.eval.joinRequest = joinRequest;
    log.info('node-eval', 'join-request-created', {
      session_id: session.id,
      candidate_id: session.candidateId ?? null,
      join_id: joinRequest.id,
      score: evalScore.score,
      expires_at: joinRequest.expires_at,
    });
    void sendJoinReady(session).catch((error) => {
      session.eval?.errors.push(`join_ready: ${error instanceof Error ? error.message : String(error)}`);
      log.error('node-eval', 'join-ready-send-failed', {
        session_id: session.id,
        candidate_id: session.candidateId ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  log.info('node-eval', 'completed', {
    session_id: session.id,
    candidate_id: session.candidateId ?? null,
    status: session.eval.status,
    score: evalScore.score,
    errors: session.eval.errors,
  });

  recordEvalResult(session, evalScore.score, evalScore.admission, integrity);
}

// Verify the eval's integrity payload against the handshake-PROVEN identity and
// the required release (bootstrap: none set → signature + identity binding only).
// Never throws; returns { ok, reason } for both the admission gate and the record.
function verifyEvalIntegrity(session: NodeTunnelSession): { ok: boolean; reason?: string } {
  const payload = session.eval?.results.integrity as IntegrityPayload | undefined;
  if (!payload) return { ok: false, reason: 'integrity payload missing' };
  if (!session.verifiedPublicKeyPem) return { ok: false, reason: 'no verified handshake identity' };

  let trustedKey: crypto.KeyObject;
  try {
    trustedKey = crypto.createPublicKey(session.verifiedPublicKeyPem);
  } catch {
    return { ok: false, reason: 'verified identity is not a valid public key' };
  }
  const required = NodeStore.getRequiredManifest();
  const result = verifyIntegrityPayload(payload, trustedKey, required?.manifest ?? null);
  return result.ok ? { ok: true } : { ok: false, reason: `${result.kind}: ${result.reason}` };
}

function scoreEvalResults(
  results: Partial<Record<EvalAction, unknown>>
): { score: number; errors: string[]; admission: AdmissionVerdict; details: Record<string, unknown> } {
  const errors: string[] = [];

  // PRIMARY gate: stable sustained 16KB capacity — the bench-cpu admission model.
  // The server derives the verdict from the node's raw composite/sustained
  // results; a node that throttles, shares its core, or is too slow to serve
  // fails here (replacing the old cpu/crypto/memory throughput minimums).
  const admission = deriveAdmission(results);
  if (!admission.stable) {
    for (const blocker of admission.blockers) errors.push(`admission: ${blocker}`);
  }

  // System-memory sanity — a basic capability floor, not a CPU score.
  const system = results.benchmark_system as { total_memory_bytes?: number } | undefined;
  const totalMemoryMb = Number(system?.total_memory_bytes ?? 0) / 1024 / 1024;
  if (totalMemoryMb < EVAL_MIN_SYSTEM_MEMORY_MB) {
    errors.push(`benchmark_system: below minimum ${EVAL_MIN_SYSTEM_MEMORY_MB}MB total memory`);
  }

  // Event-loop health — an oversubscribed or busy host shows elevated p99 here.
  const eventLoop = results.benchmark_event_loop as { ns_per_op?: { p99?: number } } | undefined;
  const eventLoopP99Ns = Number(eventLoop?.ns_per_op?.p99 ?? 0);
  if (eventLoopP99Ns <= 0 || eventLoopP99Ns > EVAL_MAX_EVENT_LOOP_P99_NS) {
    errors.push(`benchmark_event_loop: p99 above maximum ${EVAL_MAX_EVENT_LOOP_P99_NS}ns`);
  }

  return {
    score: computeHealthScore(admission, totalMemoryMb, eventLoopP99Ns),
    errors,
    admission,
    details: { ...results, admission },
  };
}

// A 0-100 health/stability score for display and the node record — this keeps
// the existing "/100" semantics. It is NOT the ranking magnitude: rank on
// admission.capacity_req_s (actual req/s). Stability dominates on purpose — a
// fast node that throttles is a worse network member than a slower one that
// holds steady.
function computeHealthScore(
  admission: AdmissionVerdict,
  totalMemoryMb: number,
  eventLoopP99Ns: number
): number {
  const stability = admission.basis !== 'sustained' ? 0 : admission.stable ? 100 : 40;
  const memory = Math.min(100, (totalMemoryMb / EVAL_MIN_SYSTEM_MEMORY_MB) * 100);
  const eventLoop =
    eventLoopP99Ns > 0 ? Math.min(100, (EVAL_MAX_EVENT_LOOP_P99_NS / eventLoopP99Ns) * 100) : 0;
  return Math.round(stability * 0.6 + memory * 0.2 + eventLoop * 0.2);
}

async function sendJoinReady(session: NodeTunnelSession): Promise<void> {
  if (!session.eval?.joinRequest) return;
  log.info('node-eval', 'join-ready-send', {
    session_id: session.id,
    candidate_id: session.candidateId ?? null,
    join_id: session.eval.joinRequest.id,
    expires_at: session.eval.joinRequest.expires_at,
  });
  await sendEncrypted(session, {
    type: MESSAGE_TYPE.JOIN_READY,
    timestamp: nowSeconds(),
    join_id: session.eval.joinRequest.id,
    alg: 'ed25519',
    nonce: session.eval.joinRequest.nonce,
    expires_at: session.eval.joinRequest.expires_at,
  });
}

function createEvalJoinRequest(publicKeyPem: string, evalScore: { score: number; details: Record<string, unknown> }): EvalJoinRequest {
  const pubkey = crypto.createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' });
  return NodeStore.createJoinRequest({
    pubkey,
    alg: 'ed25519',
    ttlSeconds: 10 * 60,
    benchmarkScore: evalScore.score,
    benchmarkDetails: evalScore.details,
  });
}

async function sendEncrypted(session: NodeTunnelSession, message: TunnelMessage, frameType: FrameType = FRAME_TYPE.DATA): Promise<void> {
  if (session.ws.readyState !== WebSocket.OPEN) return;
  const raw = sealFrame(session.secure.sendKey, frameType, session.sendSequence, encodeMessage(message));
  session.sendSequence += 1n;
  session.ws.send(raw);
}

async function requestProxy(
  session: NodeTunnelSession,
  input: {
    target_url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    body_encoding?: 'utf8' | 'base64';
  },
): Promise<ProxyResponseMessage> {
  if (session.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Control tunnel not connected for node: ${session.nodeId ?? session.id}`);
  }

  const id = crypto.randomUUID();
  const response = new Promise<TunnelMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Node proxy request timed out: ${id}`));
    }, 30_000);
    session.pending.set(id, { kind: 'proxy', resolve, reject, timer });
  });

  await sendEncrypted(session, {
    type: MESSAGE_TYPE.PROXY_REQUEST,
    id,
    timestamp: nowSeconds(),
    target_url: input.target_url,
    method: input.method,
    headers: input.headers,
    body: input.body,
    body_encoding: input.body_encoding,
  });

  const message = await response;
  if (message.type !== MESSAGE_TYPE.PROXY_RESPONSE) {
    throw new Error(`Unexpected proxy response: ${message.type}`);
  }
  return message;
}

// Drive an eval-style action over the CONTROL tunnel (a trial probe) and await its
// EVAL_RESPONSE. The node runs the same runEvalAction dispatch it uses at eval; the
// result is awaited through the generic pending map (kind: 'probe').
async function requestProbe(
  session: NodeTunnelSession,
  action: EvalAction,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<EvalResponseMessage> {
  if (session.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Control tunnel not connected for node: ${session.nodeId ?? session.id}`);
  }

  const id = crypto.randomUUID();
  const response = new Promise<TunnelMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Node probe timed out: ${action} (${id})`));
    }, timeoutMs);
    session.pending.set(id, { kind: 'probe', resolve, reject, timer });
  });

  await sendEncrypted(session, {
    type: MESSAGE_TYPE.EVAL_REQUEST,
    id,
    timestamp: nowSeconds(),
    action,
    params,
  });

  const message = await response;
  if (message.type !== MESSAGE_TYPE.EVAL_RESPONSE) {
    throw new Error(`Unexpected probe response: ${message.type}`);
  }
  if (!message.ok) {
    throw new Error(`Probe ${action} failed on node: ${message.error ?? 'unknown error'}`);
  }
  return message;
}

// Verify an integrity payload returned by a trial re-attestation. Anchored to the
// SAME proven identity + required release as eval-time verifyEvalIntegrity, reused
// here so a mid-trial binary swap is caught.
function verifyProbeIntegrity(
  session: NodeTunnelSession,
  payload: IntegrityPayload | undefined,
): { ok: boolean; reason?: string } {
  if (!payload) return { ok: false, reason: 'integrity payload missing' };
  if (!session.verifiedPublicKeyPem) return { ok: false, reason: 'no verified handshake identity' };
  let trustedKey: crypto.KeyObject;
  try {
    trustedKey = crypto.createPublicKey(session.verifiedPublicKeyPem);
  } catch {
    return { ok: false, reason: 'verified identity is not a valid public key' };
  }
  const required = NodeStore.getRequiredManifest();
  const result = verifyIntegrityPayload(payload, trustedKey, required?.manifest ?? null);
  return result.ok ? { ok: true } : { ok: false, reason: `${result.kind}: ${result.reason}` };
}

async function prepareNodeUpdate(nodeId: string, manifest: Record<string, unknown>): Promise<UpdateReadyMessage> {
  const session = getControlSession(nodeId);
  if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);

  const updateId = crypto.randomUUID();
  const targetVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  log.info('node-update', 'prepare-start', {
    node_id: nodeId,
    session_id: session.id,
    update_id: updateId,
    current_version: session.version ?? null,
    target_version: targetVersion,
  });
  session.update = {
    id: updateId,
    state: 'preparing',
    targetVersion,
    updatedAt: Date.now(),
  };
  NodeStore.setNodeUpdateState(nodeId, 'preparing', {
    update_id: updateId,
    target_version: targetVersion,
  });

  const response = new Promise<TunnelMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(updateId);
      NodeStore.setNodeUpdateState(nodeId, 'failed', {
        update_id: updateId,
        target_version: targetVersion,
        reason: 'prepare_timeout',
      });
      log.error('node-update', 'prepare-timeout', {
        node_id: nodeId,
        session_id: session.id,
        update_id: updateId,
        target_version: targetVersion,
      });
      reject(new Error(`Node update prepare timed out: ${nodeId}`));
    }, 180_000);
    session.pending.set(updateId, { kind: 'update', resolve, reject, timer });
  });

  await sendEncrypted(session, {
    type: MESSAGE_TYPE.UPDATE_PREPARE,
    id: updateId,
    timestamp: nowSeconds(),
    update_id: updateId,
    manifest,
  });

  const message = await response;
  if (message.type !== MESSAGE_TYPE.UPDATE_READY) {
    throw new Error(`Unexpected update prepare response: ${message.type}`);
  }
  log.info('node-update', 'prepare-complete', {
    node_id: nodeId,
    session_id: session.id,
    update_id: message.update_id,
    current_version: message.current_version,
    target_version: message.target_version,
    artifact_path: message.artifact_path,
    sha256: message.sha256,
  });
  return message;
}

async function applyNodeUpdate(
  nodeId: string,
  options: { updateId?: string; restartAfterMs?: number; force?: boolean } = {},
): Promise<{ update_id: string; state: string }> {
  const session = getControlSession(nodeId);
  if (!session) throw new Error(`Control tunnel not connected for node: ${nodeId}`);
  if (!session.update || session.update.state !== 'ready') {
    throw new Error(`Node update is not ready: ${nodeId}`);
  }
  if (options.updateId && options.updateId !== session.update.id) {
    throw new Error(`Update id mismatch for node ${nodeId}`);
  }
  if (!options.force && !isSessionIdle(session)) {
    throw new Error(`Node is not idle: ${nodeId}`);
  }

  log.info('node-update', 'apply-start', {
    node_id: nodeId,
    session_id: session.id,
    update_id: session.update.id,
    target_version: session.update.targetVersion,
    restart_after_ms: Math.max(0, options.restartAfterMs ?? 1_000),
    active_requests: session.activeRequests,
    active_streams: session.activeStreams,
  });
  session.update.state = 'updating';
  session.update.updatedAt = Date.now();
  NodeStore.setNodeUpdateState(nodeId, 'updating', {
    update_id: session.update.id,
    target_version: session.update.targetVersion,
  });

  await sendEncrypted(session, {
    type: MESSAGE_TYPE.UPDATE_APPLY,
    id: session.update.id,
    timestamp: nowSeconds(),
    update_id: session.update.id,
    restart_after_ms: Math.max(0, options.restartAfterMs ?? 1_000),
  });

  log.info('node-update', 'apply-sent', {
    node_id: nodeId,
    session_id: session.id,
    update_id: session.update.id,
    target_version: session.update.targetVersion,
  });
  return { update_id: session.update.id, state: session.update.state };
}

function attachProxySession(session: NodeTunnelSession, clientWs: WebSocket): { streamId: string; close: () => void } {
  const streamId = crypto.randomUUID();
  let closed = false;

  const close = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    session.streams.delete(streamId);
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_CLOSE,
      timestamp: nowSeconds(),
      stream_id: streamId,
      reason,
    }).catch(() => undefined);
  };

  session.streams.set(streamId, {
    streamId,
    onData: (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    },
    onClose: () => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000, 'node stream closed');
    },
  });

  void sendEncrypted(session, {
    type: MESSAGE_TYPE.STREAM_OPEN,
    timestamp: nowSeconds(),
    stream_id: streamId,
    target: 'proxy-session',
  }).catch((error) => {
    session.streams.delete(streamId);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, error instanceof Error ? error.message : String(error));
    }
  });

  clientWs.on('message', (data: WebSocket.RawData) => {
    if (closed || session.ws.readyState !== WebSocket.OPEN) return;
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_DATA,
      timestamp: nowSeconds(),
      stream_id: streamId,
      data: toBuffer(data).toString('base64'),
      encoding: 'base64',
    }).catch((error) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, error instanceof Error ? error.message : String(error));
      }
    });
  });

  clientWs.on('close', () => close('client closed'));
  clientWs.on('error', () => close('client error'));

  return { streamId, close };
}

function attachDataPlaneSession(session: NodeTunnelSession, clientWs: WebSocket): { streamId: string; close: (reason?: string) => void } {
  const streamId = crypto.randomUUID();
  let closed = false;

  log.info('node-tunnel', 'data-plane-stream-open', {
    session_id: session.id,
    node_id: session.nodeId ?? null,
    stream_id: streamId,
  });

  const close = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    session.streams.delete(streamId);
    log.info('node-tunnel', 'data-plane-stream-close-send', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: streamId,
      reason,
    });
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_CLOSE,
      timestamp: nowSeconds(),
      stream_id: streamId,
      reason,
    }).catch(() => undefined);
  };

  session.streams.set(streamId, {
    streamId,
    onData: (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    },
    onClose: (reason?: string) => {
      if (closed) return;
      closed = true;
      session.streams.delete(streamId);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(reason && reason !== 'target closed' ? 1011 : 1000, reason ?? 'node data-plane stream closed');
      }
    },
  });

  void sendEncrypted(session, {
    type: MESSAGE_TYPE.STREAM_OPEN,
    timestamp: nowSeconds(),
    stream_id: streamId,
    target: JSON.stringify({ kind: 'data-plane' }),
  }).catch((error) => {
    session.streams.delete(streamId);
    closed = true;
    log.error('node-tunnel', 'data-plane-stream-open-failed', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: streamId,
      message: error instanceof Error ? error.message : String(error),
    });
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, error instanceof Error ? error.message : String(error));
    }
  });

  clientWs.on('message', (data: WebSocket.RawData) => {
    if (closed || session.ws.readyState !== WebSocket.OPEN) return;
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_DATA,
      timestamp: nowSeconds(),
      stream_id: streamId,
      data: toBuffer(data).toString('base64'),
      encoding: 'base64',
    }).catch((error) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, error instanceof Error ? error.message : String(error));
      }
    });
  });

  clientWs.on('close', () => close('client websocket closed'));
  clientWs.on('error', () => close('client websocket error'));

  return { streamId, close };
}

function attachRawTunnelStream(
  session: NodeTunnelSession,
  input: {
    targetHost: string;
    targetPort: number;
    initialData?: Buffer;
    onData: (data: Buffer) => void;
    onEnd: () => void;
    onError: (error: Error) => void;
  },
): { streamId: string; send: (data: Buffer) => void; close: (reason?: string) => void } {
  const streamId = crypto.randomUUID();
  let closed = false;

  log.info('node-tunnel', 'raw-stream-open', {
    session_id: session.id,
    node_id: session.nodeId ?? null,
    stream_id: streamId,
    target_host: input.targetHost,
    target_port: input.targetPort,
    initial_bytes: input.initialData?.length ?? 0,
  });
  const close = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    session.streams.delete(streamId);
    log.info('node-tunnel', 'raw-stream-close-send', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: streamId,
      reason,
    });
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_CLOSE,
      timestamp: nowSeconds(),
      stream_id: streamId,
      reason,
    }).catch(() => undefined);
  };

  session.streams.set(streamId, {
    streamId,
    onData: input.onData,
    onClose: (reason?: string) => {
      close('node stream closed');
      if (reason && reason !== 'target closed') {
        input.onError(new Error(reason));
      } else {
        input.onEnd();
      }
    },
  });

  void sendEncrypted(session, {
    type: MESSAGE_TYPE.STREAM_OPEN,
    timestamp: nowSeconds(),
    stream_id: streamId,
    target: JSON.stringify({
      kind: 'raw-tunnel',
      host: input.targetHost,
      port: input.targetPort,
    }),
  }).then(() => {
    if (input.initialData?.length) {
      return sendEncrypted(session, {
        type: MESSAGE_TYPE.STREAM_DATA,
        timestamp: nowSeconds(),
        stream_id: streamId,
        data: input.initialData.toString('base64'),
        encoding: 'base64',
      });
    }
    return undefined;
  }).catch((error) => {
    session.streams.delete(streamId);
    closed = true;
    log.error('node-tunnel', 'raw-stream-open-failed', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      stream_id: streamId,
      target_host: input.targetHost,
      target_port: input.targetPort,
      message: error instanceof Error ? error.message : String(error),
    });
    input.onError(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    streamId,
    send: (data: Buffer) => {
      if (closed || session.ws.readyState !== WebSocket.OPEN) return;
      void sendEncrypted(session, {
        type: MESSAGE_TYPE.STREAM_DATA,
        timestamp: nowSeconds(),
        stream_id: streamId,
        data: data.toString('base64'),
        encoding: 'base64',
      }).catch((error) => input.onError(error instanceof Error ? error : new Error(String(error))));
    },
    close,
  };
}

function attachTunnelOwnerSession(
  session: NodeTunnelSession,
  input: {
    tunnelId: string;
    ownerWs: WebSocket;
  },
): { streamId: string; close: (reason?: string) => void } {
  const streamId = crypto.randomUUID();
  let closed = false;

  log.info('node-tunnel', 'tunnel-owner-open', {
    session_id: session.id,
    node_id: session.nodeId ?? null,
    tunnel_id: input.tunnelId,
    stream_id: streamId,
  });

  const close = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    session.streams.delete(streamId);
    log.info('node-tunnel', 'tunnel-owner-close-send', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      tunnel_id: input.tunnelId,
      stream_id: streamId,
      reason,
    });
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_CLOSE,
      timestamp: nowSeconds(),
      stream_id: streamId,
      reason,
    }).catch(() => undefined);
  };

  session.streams.set(streamId, {
    streamId,
    onData: (data) => {
      if (input.ownerWs.readyState === WebSocket.OPEN) input.ownerWs.send(data);
    },
    onClose: (reason?: string) => {
      close('node owner stream closed');
      if (input.ownerWs.readyState === WebSocket.OPEN) {
        input.ownerWs.close(1011, reason ?? 'node owner stream closed');
      }
    },
  });

  void sendEncrypted(session, {
    type: MESSAGE_TYPE.STREAM_OPEN,
    timestamp: nowSeconds(),
    stream_id: streamId,
    target: JSON.stringify({
      kind: 'public-tunnel-owner',
      tunnel_id: input.tunnelId,
    }),
  }).catch((error) => {
    session.streams.delete(streamId);
    closed = true;
    log.error('node-tunnel', 'tunnel-owner-open-failed', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      tunnel_id: input.tunnelId,
      stream_id: streamId,
      message: error instanceof Error ? error.message : String(error),
    });
    if (input.ownerWs.readyState === WebSocket.OPEN) {
      input.ownerWs.close(1011, error instanceof Error ? error.message : String(error));
    }
  });

  input.ownerWs.on('message', (data: WebSocket.RawData) => {
    if (closed || session.ws.readyState !== WebSocket.OPEN) return;
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_DATA,
      timestamp: nowSeconds(),
      stream_id: streamId,
      data: toBuffer(data).toString('base64'),
      encoding: 'base64',
    }).catch((error) => {
      if (input.ownerWs.readyState === WebSocket.OPEN) {
        input.ownerWs.close(1011, error instanceof Error ? error.message : String(error));
      }
    });
  });

  input.ownerWs.on('close', () => close('owner websocket closed'));
  input.ownerWs.on('error', () => close('owner websocket error'));

  return { streamId, close };
}

function attachPublicTunnelStream(
  session: NodeTunnelSession,
  input: {
    tunnelId: string;
    initialData?: Buffer;
    onData: (data: Buffer) => void;
    onEnd: () => void;
    onError: (error: Error) => void;
  },
): { streamId: string; send: (data: Buffer) => void; close: (reason?: string) => void } {
  const streamId = crypto.randomUUID();
  let closed = false;

  log.info('node-tunnel', 'public-tunnel-stream-open', {
    session_id: session.id,
    node_id: session.nodeId ?? null,
    tunnel_id: input.tunnelId,
    stream_id: streamId,
    initial_bytes: input.initialData?.length ?? 0,
  });

  const close = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    session.streams.delete(streamId);
    log.info('node-tunnel', 'public-tunnel-stream-close-send', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      tunnel_id: input.tunnelId,
      stream_id: streamId,
      reason,
    });
    void sendEncrypted(session, {
      type: MESSAGE_TYPE.STREAM_CLOSE,
      timestamp: nowSeconds(),
      stream_id: streamId,
      reason,
    }).catch(() => undefined);
  };

  session.streams.set(streamId, {
    streamId,
    onData: input.onData,
    onClose: (reason?: string) => {
      if (closed) return;
      closed = true;
      session.streams.delete(streamId);
      if (reason && reason !== 'target closed') {
        input.onError(new Error(reason));
      } else {
        input.onEnd();
      }
    },
  });

  void sendEncrypted(session, {
    type: MESSAGE_TYPE.STREAM_OPEN,
    timestamp: nowSeconds(),
    stream_id: streamId,
    target: JSON.stringify({
      kind: 'public-tunnel-stream',
      tunnel_id: input.tunnelId,
      initial_data: input.initialData?.length ? input.initialData.toString('base64') : undefined,
    }),
  }).catch((error) => {
    session.streams.delete(streamId);
    closed = true;
    log.error('node-tunnel', 'public-tunnel-stream-open-failed', {
      session_id: session.id,
      node_id: session.nodeId ?? null,
      tunnel_id: input.tunnelId,
      stream_id: streamId,
      message: error instanceof Error ? error.message : String(error),
    });
    input.onError(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    streamId,
    send: (data: Buffer) => {
      if (closed || session.ws.readyState !== WebSocket.OPEN) return;
      void sendEncrypted(session, {
        type: MESSAGE_TYPE.STREAM_DATA,
        timestamp: nowSeconds(),
        stream_id: streamId,
        data: data.toString('base64'),
        encoding: 'base64',
      }).catch((error) => input.onError(error instanceof Error ? error : new Error(String(error))));
    },
    close,
  };
}

function resolvePending(session: NodeTunnelSession, message: TunnelMessage): void {
  const replyTo = 'reply_to' in message ? message.reply_to : undefined;
  if (!replyTo) return;

  const pending = session.pending.get(replyTo);
  if (!pending) return;

  clearTimeout(pending.timer);
  session.pending.delete(replyTo);

  if (message.type === MESSAGE_TYPE.ERROR || message.type === MESSAGE_TYPE.UPDATE_FAILED) {
    pending.reject(new Error(message.message));
  } else {
    pending.resolve(message);
  }
}

function rejectPendingProxyRequests(session: NodeTunnelSession, error: Error): void {
  for (const [id, pending] of session.pending) {
    if (pending.kind !== 'proxy') continue;
    clearTimeout(pending.timer);
    pending.reject(error);
    session.pending.delete(id);
  }
}

function closeActiveStreams(session: NodeTunnelSession, reason: string): void {
  for (const [streamId, stream] of Array.from(session.streams)) {
    session.streams.delete(streamId);
    try {
      stream.onClose(reason);
    } catch (error) {
      log.error('node-tunnel', 'stream-close-handler-failed', {
        session_id: session.id,
        node_id: session.nodeId ?? null,
        stream_id: streamId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function startUpdateScheduler(router?: RouterLike): { stop: () => void } | null {
  if (process.env.CONSENSUS_NODE_AUTO_UPDATES !== 'true') {
    log.warn('node-update', 'scheduler-disabled', {
      reason: 'CONSENSUS_NODE_AUTO_UPDATES is not true',
    });
    return null;
  }
  const intervalMs = Math.max(30_000, Number(process.env.CONSENSUS_NODE_UPDATE_INTERVAL_MS ?? 60_000));
  let running = false;

  log.info('node-update', 'scheduler-started', { interval_ms: intervalMs });
  const tick = async () => {
    if (running) {
      log.warn('node-update', 'scheduler-skip', { reason: 'previous tick still running' });
      return;
    }
    running = true;
    try {
      await scheduleOneUpdate(router);
    } catch (error) {
      log.error('node-update', 'scheduler-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}

async function scheduleOneUpdate(router?: RouterLike): Promise<void> {
  const required = NodeStore.getRequiredManifest()?.manifest;
  if (!required || typeof required.version !== 'string') {
    log.info('node-update', 'scheduler-no-required-manifest', {});
    return;
  }

  const activeUpdating = Array.from(sessions.values()).some((session) =>
    session.update?.state === 'preparing' ||
    session.update?.state === 'draining' ||
    session.update?.state === 'updating',
  );
  if (activeUpdating) {
    log.info('node-update', 'scheduler-wait-active-update', {
      required_version: required.version,
    });
    return;
  }
  for (const session of sessions.values()) {
    if (!session.nodeId || session.mode !== 'control') {
      log.info('node-update', 'scheduler-skip-session', {
        session_id: session.id,
        mode: session.mode,
        node_id: session.nodeId ?? null,
        reason: 'not a registered control session',
      });
      continue;
    }
    if (session.version === required.version) {
      continue;
    }
    if (!isSessionIdle(session, router)) {
      const load = router?.getNodeLoad?.(session.nodeId) ?? { requests: 0, sessions: 0, total: 0 };
      log.info('node-update', 'scheduler-wait-idle', {
        session_id: session.id,
        node_id: session.nodeId,
        current_version: session.version ?? null,
        target_version: required.version,
        pending: session.pending.size,
        streams: session.streams.size,
        active_requests: session.activeRequests,
        active_streams: session.activeStreams,
        router_requests: load.requests,
        router_sessions: load.sessions,
      });
      continue;
    }

    log.info('node-update', 'scheduler-selected', {
      session_id: session.id,
      node_id: session.nodeId,
      current_version: session.version ?? null,
      target_version: required.version,
    });
    const ready = await prepareNodeUpdate(session.nodeId, required);
    NodeStore.setNodeUpdateState(session.nodeId, 'draining', {
      update_id: ready.update_id,
      target_version: ready.target_version,
    });
    log.info('node-update', 'draining', {
      session_id: session.id,
      node_id: session.nodeId,
      update_id: ready.update_id,
      target_version: ready.target_version,
    });
    await applyNodeUpdate(session.nodeId, { updateId: ready.update_id });
    return;
  }
}

function getStats() {
  const now = Date.now();
  const active = Array.from(sessions.values()).map((session) => ({
    session_id: session.id,
    mode: session.mode,
    node_id: session.nodeId ?? null,
    candidate_id: session.candidateId ?? null,
    version: session.version ?? null,
    active_requests: session.activeRequests,
    active_streams: session.activeStreams,
    update: session.update ?? null,
    connected_for_ms: now - session.connectedAt,
    last_seen_ms_ago: now - session.lastSeenAt,
    eval: session.eval
      ? {
          status: session.eval.status,
          requested: session.eval.requested,
          completed: session.eval.completedAt != null,
          errors: session.eval.errors,
          join_request: session.eval.joinRequest
            ? {
                id: session.eval.joinRequest.id,
                alg: session.eval.joinRequest.alg,
                expires_at: session.eval.joinRequest.expires_at,
              }
            : null,
        }
      : null,
  }));

  return {
    active_sessions: sessions.size,
    active_eval_sessions: active.filter((session) => session.mode === 'eval').length,
    active_control_sessions: active.filter((session) => session.mode === 'control').length,
    sessions: active,
  };
}

function clearCompletedUpdateState(nodeId: string, version: string | undefined, source: string): void {
  if (!version) return;
  try {
    const node = NodeStore.getNode(nodeId);
    const targetVersion = node?.capabilities?.update_target_version;
    const state = node?.capabilities?.update_state;
    if (!state || targetVersion !== version) return;

    NodeStore.setNodeUpdateState(nodeId, null);
    log.info('node-update', 'state-cleared-after-reconnect', {
      node_id: nodeId,
      version,
      previous_state: state,
      source,
    });
  } catch (error) {
    log.error('node-update', 'state-clear-failed', {
      node_id: nodeId,
      version,
      source,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function isSessionIdle(session: NodeTunnelSession, router?: RouterLike): boolean {
  const routerLoad = session.nodeId ? router?.getNodeLoad?.(session.nodeId) : null;
  const routerTotal = routerLoad?.total ?? 0;
  return session.pending.size === 0 &&
    session.streams.size === 0 &&
    session.activeRequests === 0 &&
    session.activeStreams === 0 &&
    routerTotal === 0;
}

function getControlSession(nodeId: string): NodeTunnelSession | null {
  const sessionId = byNodeId.get(nodeId);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.mode !== 'control' || session.ws.readyState !== WebSocket.OPEN) return null;
  return session;
}

function requireLoopback(req: any, res: any, next: () => void) {
  const remote = req.socket.remoteAddress ?? '';
  const ok = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (ok) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') output[key] = item;
  }
  return output;
}

function decodeMessageBody(body: string | undefined, encoding: 'utf8' | 'base64' | undefined): string {
  if (!body) return '';
  if (encoding === 'base64') return Buffer.from(body, 'base64').toString('utf8');
  return body;
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = url.search ? '?...' : '';
    return url.toString();
  } catch {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
