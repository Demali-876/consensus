import crypto from "crypto";
import Router from "./router.ts";
import { WebSocketServer } from "ws";
import { paymentMiddleware } from "@x402/express";
import WebSocket from "ws";
import {
  PRICING_PRESETS,
  calculateSessionLimits,
  calculateSessionCost,
  bytesToMB,
  msToMinutes,
} from "./utils/types.js";

const sessions = new Map();
const pendingSessions = new Map();
const TOKEN_TTL_MS = 60_000;

/**
 * Register WebSocket route with x402 payment protection
 * @param {Express} app - Express app instance
 * @param {https.Server} httpsServer - HTTPS server instance
 * @param {x402ResourceServer} x402Server - x402 server instance
 * @param {Object} config - Configuration
 * @param {Router} router - shared router instance
 */
export function registerWebSocket(app, httpsServer, x402Server, config, router){
  const { EVM_PAY_TO, SOLANA_PAY_TO, localMode } = config;
  const wsProtocol = localMode ? "ws" : "wss";
  const httpProtocol = localMode ? "http" : "https";

  app.get(
    "/ws",
    paymentMiddleware(
      {
        "GET /ws": {
          accepts: [
            {
              scheme: "exact",
              price: (context) => {
                const model = context.adapter.getQueryParam?.("model") ?? "hybrid";
                const minutes = parseInt(context.adapter.getQueryParam?.("minutes") ?? "5");
                const megabytes = parseInt(context.adapter.getQueryParam?.("megabytes") ?? "50");

                const pricingKey = model === "time" ? "TIME" : model === "data" ? "DATA" : "HYBRID";
                const pricing = PRICING_PRESETS[pricingKey];
                const cost = calculateSessionCost(pricing, minutes, megabytes);

                return `$${cost.toFixed(4)}`;
              },
              network: "eip155:84532",
              payTo: EVM_PAY_TO,
            },
            {
              scheme: "exact",
              price: (context) => {
                const model = context.adapter.getQueryParam?.("model") ?? "hybrid";
                const minutes = parseInt(context.adapter.getQueryParam?.("minutes") ?? "5");
                const megabytes = parseInt(context.adapter.getQueryParam?.("megabytes") ?? "50");

                const pricingKey = model === "time" ? "TIME" : model === "data" ? "DATA" : "HYBRID";
                const pricing = PRICING_PRESETS[pricingKey];
                const cost = calculateSessionCost(pricing, minutes, megabytes);

                return `$${cost.toFixed(4)}`;
              },
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              payTo: SOLANA_PAY_TO,
            },
          ],
          description: "Pay-per-use WebSockets on demand",
          mimeType: "application/json",
        },
      },
      x402Server
    ),
    (req, res) => {
      const model = (req.query.model ?? "hybrid").toString();
      const minutes = parseInt((req.query.minutes ?? "5").toString(), 10);
      const megabytes = parseInt((req.query.megabytes ?? "50").toString(), 10);

      const token = crypto.randomBytes(32).toString("hex");
      const expires = Date.now() + TOKEN_TTL_MS;

      pendingSessions.set(token, { model, minutes, megabytes, expires });

      res.json({
        token,
        connect_url: `${wsProtocol}://${req.headers.host}/ws-connect?token=${token}`,
        expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      });
    }
  );

  const wss = new WebSocketServer({noServer: true});

  httpsServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `${httpProtocol}://${req.headers.host}`);

    if(url.pathname !== "/ws-connect"){
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    const pending = token ? pendingSessions.get(token) : null;
    
    if (!pending){
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pending.expires < Date.now()) {
      pendingSessions.delete(token);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    pendingSessions.delete(token);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.purchase = pending;
      ws.token = token;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const { model, minutes, megabytes } = ws.purchase;
    const sessionId = crypto.randomUUID();

    const preferenceHeaders = {
      'x-node-region': req.headers['x-node-region'],
      'x-node-domain': req.headers['x-node-domain'],
      'x-node-exclude': req.headers['x-node-exclude'],
    };
    
    const node = router.selectNode(sessionId, preferenceHeaders);

    if (node) {
      handleNodeProxiedSession(ws, node, sessionId, model, minutes, megabytes);
    } else {
      console.log(`[WebSocket Self-Fallback] No nodes available, handling locally`);
      handleLocalSession(ws, sessionId, model, minutes, megabytes);
    }
  });

  /**
   * Handle WebSocket session on a remote node (proxy)
   */
  function handleNodeProxiedSession(clientWs, node, sessionId, model, minutes, megabytes) {
    router.incrementSession(node.id);
    console.log(`[WebSocket Route] ${sessionId} → ${node.id} (${node.region})`);

    const pricingKey = model === "time" ? "TIME" : model === "data" ? "DATA" : "HYBRID";
    const pricing = PRICING_PRESETS[pricingKey];
    const limits = calculateSessionLimits(pricing, minutes, megabytes);

    const session = {
      sessionId,
      nodeId: node.id,
      pricing,
      limits,
      usage: {
        bytesReceived: 0,
        bytesSent: 0,
        totalBytes: 0,
        connectedAt: Date.now(),
      },
      active: true,
    };

    sessions.set(sessionId, session);

    const nodeWs = new WebSocket(`${wsProtocol}://${node.domain}/ws-node`, {
      headers: {
        'x-session-id': sessionId,
        'x-model': model,
        'x-minutes': minutes.toString(),
        'x-megabytes': megabytes.toString(),
      }
    });

    nodeWs.on('open', () => {
      console.log(`[Node Connected] ${sessionId} ↔ ${node.id}`);

      clientWs.send(
        JSON.stringify({
          type: "session_start",
          sessionId,
          model,
          served_by: node.id,
          limits: {
            timeSeconds: limits.timeLimit / 1000,
            dataMB: bytesToMB(limits.dataLimit),
          },
          pricing: {
            totalCost: calculateSessionCost(pricing, minutes, megabytes),
            pricePerMinute: pricing.pricePerMinute,
            pricePerMB: pricing.pricePerMB,
          },
        })
      );
    });

    nodeWs.on('error', (error) => {
      console.error(`[Node Error] ${node.id}:`, error.message);

      console.log(`[WebSocket Fallback] ${sessionId} falling back to local`);
      nodeWs.close();
      router.decrementSession(node.id);
      sessions.delete(sessionId);
      handleLocalSession(clientWs, sessionId, model, minutes, megabytes);
    });

    clientWs.on('message', (data) => {
      if (!session.active) return;
      
      const size = Buffer.byteLength(data);
      session.usage.bytesReceived += size;
      session.usage.totalBytes = session.usage.bytesReceived + session.usage.bytesSent;

      if (nodeWs.readyState === WebSocket.OPEN) {
        nodeWs.send(data);
      }
    });

    nodeWs.on('message', (data) => {
      if (!session.active) return;

      const size = Buffer.byteLength(data);
      session.usage.bytesSent += size;
      session.usage.totalBytes = session.usage.bytesReceived + session.usage.bytesSent;

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    clientWs.on('close', () => {
      session.active = false;
      nodeWs.close();
      router.decrementSession(node.id);
      sessions.delete(sessionId);
      console.log(`[Client Disconnected] ${sessionId}`);
    });

    nodeWs.on('close', () => {
      session.active = false;
      clientWs.close();
      router.decrementSession(node.id);
      sessions.delete(sessionId);
      console.log(`[Node Disconnected] ${sessionId} from ${node.id}`);
    });
  }

  /**
   * Handle WebSocket session locally (self-fallback)
   */
  function handleLocalSession(ws, sessionId, model, minutes, megabytes) {
    const pricingKey = model === "time" ? "TIME" : model === "data" ? "DATA" : "HYBRID";
    const pricing = PRICING_PRESETS[pricingKey];
    const totalCost = calculateSessionCost(pricing, minutes, megabytes);
    const limits = calculateSessionLimits(pricing, minutes, megabytes);

    const session = {
      sessionId,
      nodeId: 'local',
      pricing,
      limits,
      usage: {
        bytesReceived: 0,
        bytesSent: 0,
        totalBytes: 0,
        durationMs: 0,
        durationSeconds: 0,
        connectedAt: Date.now(),
      },
      active: true,
    };

    sessions.set(sessionId, session);

    ws.send(
      JSON.stringify({
        type: "session_start",
        sessionId,
        model,
        served_by: 'local',
        limits: {
          timeSeconds: limits.timeLimit / 1000,
          dataMB: bytesToMB(limits.dataLimit),
        },
        pricing: {
          totalCost,
          pricePerMinute: pricing.pricePerMinute,
          pricePerMB: pricing.pricePerMB,
        },
      })
    );

    session.timer = setTimeout(() => {
      if (!session.active) return;

      const duration = Date.now() - session.usage.connectedAt;

      ws.send(
        JSON.stringify({
          type: "session_expired",
          reason: "time_limit_reached",
          finalUsage: {
            durationMinutes: msToMinutes(duration),
            dataMB: bytesToMB(session.usage.totalBytes),
          },
        })
      );

      ws.close(1000, "Time limit reached");
    }, limits.timeLimit);

    ws.on("message", (data) => {
      if (!session.active) return;

      const size = Buffer.byteLength(data);
      session.usage.bytesReceived += size;
      session.usage.totalBytes = session.usage.bytesReceived + session.usage.bytesSent;

      if (session.usage.totalBytes >= limits.dataLimit) {
        clearTimeout(session.timer);
        session.active = false;

        ws.send(
          JSON.stringify({
            type: "session_expired",
            reason: "data_limit_reached",
            finalUsage: {
              durationMinutes: msToMinutes(Date.now() - session.usage.connectedAt),
              dataMB: bytesToMB(session.usage.totalBytes),
            },
          })
        );

        ws.close(1008, "Data limit reached");
        return;
      }

      const response = `Echo: ${data}`;
      const responseSize = Buffer.byteLength(response);
      session.usage.bytesSent += responseSize;
      session.usage.totalBytes = session.usage.bytesReceived + session.usage.bytesSent;

      ws.send(response);
    });

    ws.on("close", () => {
      clearTimeout(session.timer);
      session.active = false;

      const duration = Date.now() - session.usage.connectedAt;
      session.usage.durationMs = duration;
      session.usage.disconnectedAt = Date.now();

      sessions.delete(sessionId);
    });
  };

  setInterval(() => {
    const now = Date.now();
    for (const [token, p] of pendingSessions) {
      if (p.expires < now) {
        pendingSessions.delete(token);
      }
    }
  }, 10_000);

  return {
    getStats: () => ({
      active_sessions: sessions.size,
      pending_tokens: pendingSessions.size,
      router_stats: router.getStats(),
    }),
  };
}