import crypto from "crypto";
import { WebSocketServer } from "ws";
import { paymentMiddleware } from "@x402/express";
import {
  PRICING_PRESETS,
  calculateSessionLimits,
  bytesToMB,
  msToMinutes,
} from ".utils/types.js";

const sessions = new Map();
const pendingSessions = new Map();
const TOKEN_TTL_MS = 60_000;

/**
 * Register WebSocket route with x402 payment protection
 * @param {Express} app - Express app instance
 * @param {https.Server} httpsServer - HTTPS server instance
 * @param {x402ResourceServer} x402Server - x402 server instance
 * @param {Object} config - Configuration
 */
export function registerWebSocket(app, httpsServer, x402Server, config){
  const  {EVM_PAY_TO, SOLANA_PAY_TO } = config;

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

                let cost = 0;
                if (model === "time" || model === "hybrid") {
                  cost += minutes * 0.0005;
                }
                if (model === "data" || model === "hybrid") {
                  cost += megabytes * 0.0001;
                }

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

                let cost = 0;
                if (model === "time" || model === "hybrid") {
                  cost += minutes * 0.0005;
                }
                if (model === "data" || model === "hybrid") {
                  cost += megabytes * 0.0001;
                }

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
        connect_url: `wss://${req.headers.host}/ws-connect?token=${token}`,
        expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      });
    }
  );
  const wss = new WebSocketServer({noServer: true});

  httpsServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `https://${req.headers.host}`);

    if(url.pathname !== "/ws-connect"){
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    const pending = token ? pendingSessions.get(token) : null;
    
    if (!pending){
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
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
      wss.emit("connection", ws, req);
    });
  })

  wss.on("connection", (ws, req) => {
    const { model, minutes, megabytes } = ws.purchase;

    const pricingKey = model === "time" ? "TIME" : model === "data" ? "DATA" : "HYBRID";
    const pricing = PRICING_PRESETS[pricingKey];

    let totalCost = 0;
    if (model === "time" || model === "hybrid") {
      totalCost += minutes * pricing.pricePerMinute;
    }
    if (model === "data" || model === "hybrid") {
      totalCost += megabytes * pricing.pricePerMB;
    }

    const limits = calculateSessionLimits(pricing, minutes, megabytes);

    const sessionId = crypto.randomUUID();
    const session = {
      sessionId,
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
  });

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
    }),
  };

}