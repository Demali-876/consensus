import "dotenv/config";
import http from "http";
import path from "path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// Set local DB path before any imports that use it
process.env.NODE_DB_PATH = process.env.NODE_DB_PATH || './consensus-local.db';

import ConsensusProxy from "./proxy.js";
import Router from "./router.ts";
import { registerWebSocket } from "./wss.js";
import { registerNodes } from "./orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.LOCAL_PORT || 8082);
const HOST = process.env.HOST || "::";
const FACILITATOR_URL = "https://facilitator.payai.network";
const EVM_PAY_TO = "0x9cd64438C8e66E7e85EB097b516541Cd50780845";
const SOLANA_PAY_TO = "J6EHzeiWxrffitfscuaZty9A9AKQVPte7G9VEoHubuGw";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402Server = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

const router = new Router();
const proxy = new ConsensusProxy({ router, localMode: true });

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

const localConfig = {
  EVM_PAY_TO,
  SOLANA_PAY_TO,
  localMode: true,
};

const wsStats = registerWebSocket(app, server, x402Server, localConfig, router);
const nodeStats = registerNodes(app, server, x402Server, localConfig);

app.get("/", (req, res) => {
  res.json({
    name: "Consensus Local Dev Server",
    version: "2.0.0",
    status: "running",
    mode: "local",
    payment_networks: {
      evm: { chain: "Base Sepolia", address: EVM_PAY_TO },
      solana: { chain: "Devnet", address: SOLANA_PAY_TO },
    },
    facilitator: FACILITATOR_URL,
    note: "Node join is free in local mode. Proxy and WebSocket routes still require payment.",
  });
});

app.get("/health", (req, res) => {
  const stats = proxy.getStats();
  const ws = wsStats.getStats();
  const nodes = nodeStats.getStats();
  res.json({
    status: "healthy",
    mode: "local",
    timestamp: new Date().toISOString(),
    proxy: {
      cache_size: stats.cache_size,
      total_requests: stats.total_requests,
      cache_hits: stats.cache_hits,
    },
    websocket: ws,
    nodes: nodes,
  });
});

app.get("/stats", (req, res) => {
  const stats = proxy.getStats();
  res.json({
    ...stats,
    cache_hit_rate:
      stats.total_requests > 0
        ? ((stats.cache_hits / stats.total_requests) * 100).toFixed(2) + "%"
        : "0%",
    uptime: process.uptime(),
  });
});

app.use(
  paymentMiddleware(
    {
      "POST /proxy": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: EVM_PAY_TO,
          },
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            payTo: SOLANA_PAY_TO,
          },
        ],
        description: "API Deduplication Service",
        mimeType: "application/json",
      },
    },
    x402Server
  )
);

app.post("/proxy", async (req, res) => {
  const startTime = Date.now();

  try {
    const { target_url, method = "GET", headers = {}, body } = req.body;

    if (!target_url) {
      return res.status(400).json({ error: "Missing target_url" });
    }

    const methodUpper = String(method).toUpperCase();
    const isVerbose = Boolean(headers["x-verbose"] || headers["X-Verbose"]);

    if (!headers["x-idempotency-key"] && !headers["idempotency-key"] && !headers["X-Idempotency-Key"]) {
      headers["x-idempotency-key"] = crypto.randomBytes(16).toString("hex");
    }

    const response = await proxy.handleRequest(target_url, methodUpper, headers, body);

    const processingTime = Date.now() - startTime;

    const fullResponse = {
      status: response.status,
      statusText: response.statusText || "OK",
      headers: response.headers,
      data: response.data,
      meta: {
        cached: response.cached,
        dedupe_key: response.dedupe_key,
        processing_ms: processingTime,
        timestamp: new Date().toISOString(),
      },
    };

    const payload = isVerbose
      ? fullResponse
      : { status: fullResponse.status, statusText: fullResponse.statusText, data: fullResponse.data };

    return res.status(fullResponse.status).json(payload);
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      error: "Proxy request failed",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Consensus Local Dev Server`);
  console.log(`Mode: LOCAL (node join is free, proxy/ws require payment)`);
  const logHost = HOST === "::" || HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`URL: http://${logHost}:${PORT}`);
  console.log(`Database: ${process.env.NODE_DB_PATH}`);
});

["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  });
});
