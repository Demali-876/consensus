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

interface PendingTunnelRequest {
  kind: 'proxy' | 'update';
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
  };
}

type EvalJoinRequest = NonNullable<NonNullable<NodeTunnelSession['eval']>['joinRequest']>;
type RouterLike = {
  getNodeLoad?(nodeId: string): { requests: number; sessions: number; total: number };
};

const sessions = new Map<string, NodeTunnelSession>();
const byNodeId = new Map<string, string>();
const EVAL_MIN_CPU_HASHES_PER_SECOND = 5_000;
const EVAL_MIN_CPU_BYTES_PER_SECOND = 5 * 1024 * 1024;
const EVAL_MIN_CRYPTO_BYTES_PER_SECOND = 10 * 1024 * 1024;
const EVAL_MIN_MEMORY_ALLOCATED_MB = 128;
const EVAL_MIN_MEMORY_BYTES_PER_SECOND = 128 * 1024 * 1024;
const EVAL_MIN_SYSTEM_MEMORY_MB = 512;
const EVAL_MAX_EVENT_LOOP_P99_NS = 50_000_000;

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
  if (node.status !== 'active') throw new Error(`Registered node is not active: ${nodeId}`);
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
    session.nodeId = message.node_id;
    session.activeRequests = message.active_requests ?? 0;
    session.activeStreams = message.active_streams ?? 0;
    byNodeId.set(message.node_id, session.id);
    try {
      NodeStore.heartbeat(message.node_id, {
        rps: message.active_requests ?? null,
        p95_ms: null,
        version: session.version ?? null,
      });
    } catch (error) {
      log.error('node-tunnel', 'heartbeat-store-failed', {
        node_id: message.node_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    clearCompletedUpdateState(message.node_id, session.version, 'heartbeat');
    return;
  }
  if (message.type === MESSAGE_TYPE.EVAL_RESPONSE) {
    handleEvalResponse(session, message);
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

async function handleHello(session: NodeTunnelSession, message: HelloMessage): Promise<void> {
  session.mode = message.mode;
  session.nodeId = message.node_id;
  session.candidateId = message.candidate_id;
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
  const actions: EvalAction[] = [
    'capabilities',
    'integrity',
    'benchmark_system',
    'benchmark_cpu',
    'benchmark_crypto',
    'benchmark_memory',
    'benchmark_event_loop',
  ];
  session.eval = {
    status: 'pending',
    requested: actions,
    results: {},
    errors: [],
    startedAt: Date.now(),
  };

  for (const action of actions) {
    log.info('node-eval', 'request', {
      session_id: session.id,
      candidate_id: session.candidateId ?? null,
      action,
    });
    await sendEncrypted(session, {
      type: MESSAGE_TYPE.EVAL_REQUEST,
      id: crypto.randomUUID(),
      timestamp: nowSeconds(),
      action,
      params: evalParams(action),
    });
  }
}

function evalParams(action: EvalAction): Record<string, unknown> | undefined {
  if (action === 'benchmark_cpu') return { iterations: 5_000, data: 'consensus-node-eval' };
  if (action === 'benchmark_crypto') return { iterations: 500, payload_size_kb: 16 };
  if (action === 'benchmark_memory_pressure') return { test_size_mb: 128, rounds: 2 };
  return undefined;
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
  if (message.ok) {
    session.eval.results[message.action] = message.result;
  } else {
    session.eval.errors.push(`${message.action}: ${message.error ?? 'unknown error'}`);
  }

  const complete = session.eval.requested.every((action) =>
    Object.prototype.hasOwnProperty.call(session.eval!.results, action) ||
    session.eval!.errors.some((error) => error.startsWith(`${action}:`)),
  );

  if (!complete) return;

  session.eval.completedAt = Date.now();
  const evalScore = scoreEvalResults(session.eval.results);
  session.eval.errors.push(...evalScore.errors);
  session.eval.status = session.eval.errors.length === 0 ? 'passed' : 'failed';
  if (session.eval.status === 'passed' && session.publicKeyPem) {
    const joinRequest = createEvalJoinRequest(session.publicKeyPem, evalScore);
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
}

function scoreEvalResults(results: Partial<Record<EvalAction, unknown>>): { score: number; errors: string[]; details: Partial<Record<EvalAction, unknown>> } {
  const errors: string[] = [];
  const cpu = results.benchmark_cpu as { bytes_per_second?: number; hashes_per_second?: number } | undefined;
  const cryptoResult = results.benchmark_crypto as { total_bytes_per_second?: number } | undefined;
  const memory = results.benchmark_memory as { bytes_per_second?: number } | undefined;
  const legacyMemory = results.benchmark_memory_pressure as { allocated_mb?: number } | undefined;
  const system = results.benchmark_system as { total_memory_bytes?: number } | undefined;
  const eventLoop = results.benchmark_event_loop as { ns_per_op?: { p99?: number } } | undefined;
  const cpuBytesPerSecond = Number(cpu?.bytes_per_second ?? 0);
  const cpuHashesPerSecond = Number(cpu?.hashes_per_second ?? 0);
  const cpuValue = cpuBytesPerSecond > 0 ? cpuBytesPerSecond : cpuHashesPerSecond;
  const cpuMinimum = cpuBytesPerSecond > 0 ? EVAL_MIN_CPU_BYTES_PER_SECOND : EVAL_MIN_CPU_HASHES_PER_SECOND;
  const memoryBytesPerSecond = Number(memory?.bytes_per_second ?? 0);
  const legacyMemoryAllocatedMb = Number(legacyMemory?.allocated_mb ?? 0);
  const memoryScore = memoryBytesPerSecond > 0
    ? Math.min(100, (memoryBytesPerSecond / EVAL_MIN_MEMORY_BYTES_PER_SECOND) * 70)
    : Math.min(100, (legacyMemoryAllocatedMb / EVAL_MIN_MEMORY_ALLOCATED_MB) * 70);
  const eventLoopP99Ns = Number(eventLoop?.ns_per_op?.p99 ?? 0);
  const eventLoopScore = eventLoopP99Ns > 0
    ? Math.min(100, (EVAL_MAX_EVENT_LOOP_P99_NS / eventLoopP99Ns) * 70)
    : 0;
  const cpuScore = Math.min(100, (cpuValue / cpuMinimum) * 70);
  const cryptoScore = Math.min(100, (Number(cryptoResult?.total_bytes_per_second ?? 0) / EVAL_MIN_CRYPTO_BYTES_PER_SECOND) * 70);
  const totalMemoryMb = Number(system?.total_memory_bytes ?? 0) / 1024 / 1024;
  const systemScore = Math.min(100, (totalMemoryMb / EVAL_MIN_SYSTEM_MEMORY_MB) * 70);

  if (cpuValue < cpuMinimum) {
    errors.push(cpuBytesPerSecond > 0
      ? `benchmark_cpu: below minimum ${EVAL_MIN_CPU_BYTES_PER_SECOND} bytes/sec`
      : `benchmark_cpu: below minimum ${EVAL_MIN_CPU_HASHES_PER_SECOND} hashes/sec`);
  }
  if (Number(cryptoResult?.total_bytes_per_second ?? 0) < EVAL_MIN_CRYPTO_BYTES_PER_SECOND) {
    errors.push(`benchmark_crypto: below minimum ${EVAL_MIN_CRYPTO_BYTES_PER_SECOND} bytes/sec`);
  }
  if (memoryBytesPerSecond > 0) {
    if (memoryBytesPerSecond < EVAL_MIN_MEMORY_BYTES_PER_SECOND) {
      errors.push(`benchmark_memory: below minimum ${EVAL_MIN_MEMORY_BYTES_PER_SECOND} bytes/sec`);
    }
  } else if (legacyMemoryAllocatedMb > 0) {
    if (legacyMemoryAllocatedMb < EVAL_MIN_MEMORY_ALLOCATED_MB) {
      errors.push(`benchmark_memory_pressure: below minimum ${EVAL_MIN_MEMORY_ALLOCATED_MB}MB allocated`);
    }
  } else {
    errors.push('benchmark_memory: missing result');
  }
  if (totalMemoryMb < EVAL_MIN_SYSTEM_MEMORY_MB) {
    errors.push(`benchmark_system: below minimum ${EVAL_MIN_SYSTEM_MEMORY_MB}MB total memory`);
  }
  if (eventLoopP99Ns <= 0 || eventLoopP99Ns > EVAL_MAX_EVENT_LOOP_P99_NS) {
    errors.push(`benchmark_event_loop: p99 above maximum ${EVAL_MAX_EVENT_LOOP_P99_NS}ns`);
  }
  return {
    score: Math.round(cpuScore * 0.2 + cryptoScore * 0.3 + memoryScore * 0.2 + systemScore * 0.15 + eventLoopScore * 0.15),
    errors,
    details: results,
  };
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

function createEvalJoinRequest(publicKeyPem: string, evalScore: { score: number; details: Partial<Record<EvalAction, unknown>> }): EvalJoinRequest {
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
