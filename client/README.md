<p align="center">
  <img src="https://raw.githubusercontent.com/Demali-876/consensus/main/assets/dark-logo.png" alt="Consensus logo" width="220" />
</p>

<h1 align="center">Consensus CLI</h1>

<p align="center">
  TypeScript SDK + CLI for the <strong>Consensus Network</strong>.<br/>
  Route outbound HTTP through decentralized proxy nodes and open paid WebSocket sessions with x402 micropayments.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@canister-software/consensus-cli"><img alt="npm version" src="https://img.shields.io/npm/v/@canister-software/consensus-cli.svg"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue"/></a>
  <a href="https://github.com/Demali-876/consensus/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demali-876/consensus?style=social"/></a>
  <a href="#"><img alt="Status" src="https://img.shields.io/badge/status-beta-orange"/></a>
</p>

---

- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [ProxyClient](#proxyclient)
  - [ProxyClient Options](#proxyclient-options)
  - [Auto Strategy (Default)](#auto-strategy-default)
  - [Manual Strategy](#manual-strategy)
  - [Per-Request Node Selection](#per-request-node-selection)
- [SocketClient](#socketclient)
  - [SocketClient Options](#socketclient-options)
  - [Billing Models](#billing-models)
  - [Basic Usage](#basic-usage)
  - [Node Filtering](#node-filtering)
  - [Reconnection](#reconnection)
  - [Safe Mode](#safe-mode)
  - [Session State](#session-state)
- [CLI Commands](#cli-commands)
- [Setup Process](#setup-process)
- [Security](#security)

---

## Installation

```bash
npm install @canister-software/consensus-cli
```

---

## Environment Setup

Create a `.env` file in the root of your project with your CDP credentials:

```env
CDP_API_KEY_ID=your_cdp_key_id
CDP_API_KEY_SECRET=your_cdp_key_secret
CDP_WALLET_SECRET=your_cdp_wallet_secret
```

Get your CDP credentials at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/).

You can also override the default server with:

```env
CONSENSUS_SERVER_URL=https://your-custom-node.example.com
```

---

## ProxyClient

`ProxyClient(fetchWithPayment, options)` returns Express-compatible middleware that routes your outbound HTTP requests through Consensus proxy nodes, handling x402 payments automatically.

### ProxyClient Options

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `"inclusive" \| "exclusive"` | `"inclusive"` | `inclusive` proxies all routes **except** those in `routes`. `exclusive` proxies **only** the listed routes. |
| `routes` | `string[]` | `[]` | Route paths to include or exclude, depending on `mode`. |
| `matchSubroutes` | `boolean` | `false` | When `true`, a route match also applies to all sub-paths beneath it. |
| `strategy` | `"auto" \| "manual"` | `"auto"` | `auto` transparently intercepts `fetch()` calls within middleware. `manual` exposes `req.consensus.fetch()` for explicit control. |
| `cache_ttl` | `number` | — | TTL in seconds for node-level response caching. |
| `verbose` | `boolean` | `false` | Enables verbose response metadata from the proxy node. |
| `node_region` | `string` | — | Prefer proxy nodes in a specific geographic region. |
| `node_domain` | `string` | — | Route through a specific node domain. |
| `node_exclude` | `string` | — | Exclude a specific node domain from selection. |

### Auto Strategy (Default)

In `auto` mode, `ProxyClient` intercepts the global `fetch()` within the request context so your route handlers require no changes.

```ts
import express from "express";
import { ProxyClient } from "@canister-software/consensus-cli";

const app = express();

// Proxy only /price — all other routes use direct fetch
app.use(
  ProxyClient(fetchWithPayment, {
    mode: "exclusive",
    routes: ["/price"],
    matchSubroutes: false,
    strategy: "auto",
    cache_ttl: 60,
    verbose: true,
  })
);

// No changes needed — fetch() is automatically proxied for /price
app.get("/price", async (_req, res) => {
  const response = await fetch("https://api.example.com/price");
  res.json(await response.json());
});
```

### Manual Strategy

In `manual` mode, the proxy is not applied automatically. Use `req.consensus.fetch()` to explicitly proxy individual requests, or `req.consensus.request()` for a lower-level structured payload:

```ts
app.use(ProxyClient(fetchWithPayment, { strategy: "manual" }));

app.get("/data", async (req, res) => {
  // Proxied fetch — returns a standard Response
  const response = await req.consensus.fetch("https://api.example.com/data");
  res.json(await response.json());

  // Or use the structured request helper — returns a ProxyResponseShape
  const result = await req.consensus.request({
    target_url: "https://api.example.com/data",
    method: "GET",
  });
  res.json(result.data);
});
```

### Per-Request Node Selection

Both `req.consensus.fetch()` and `req.consensus.request()` accept per-request options as a second argument to override node routing at the call level:

```ts
const response = await req.consensus.fetch(
  "https://api.example.com/data",
  { method: "GET" },
  { node_region: "us-east", cache_ttl: 30 }
);
```

---

## SocketClient

`SocketClient(fetchWithPayment, options)` returns a client for opening paid WebSocket sessions through the Consensus Network. Token acquisition and reconnection are handled automatically.

### SocketClient Options

| Option | Type | Default | Description |
|---|---|---|---|
| `openTimeoutMs` | `number` | `12000` | Milliseconds to wait for the WebSocket connection to open before timing out. |
| `reconnectIntervalMs` | `number` | `2000` | Milliseconds between automatic reconnection attempts. |
| `defaults` | `ConsensusSocketTokenParams` | — | Default token parameters applied to every `requestToken()` call unless overridden. |
| `webSocketFactory` | `constructor` | auto-detected | Custom WebSocket constructor (browser `WebSocket` or `ws` for Node.js). Auto-detected if not provided. |

### Billing Models

Token requests accept a `model` parameter to control how your session is billed:

| Model | Description |
|---|---|
| `"hybrid"` | Billed by both time and data (default). |
| `"time"` | Billed by duration only (`minutes`). |
| `"data"` | Billed by data transfer only (`megabytes`). |

### Basic Usage

```ts
import { SocketClient } from "@canister-software/consensus-cli";

const client = SocketClient(fetchWithPayment, {
  reconnectIntervalMs: 2000,
});

// Request a session token — pays for a time-based session
const auth = await client.requestToken({
  model: "time",
  minutes: 5,
  megabytes: 0,
});

// Connect using the token — returns a managed session
const session = await client.connect(auth);

session.on("open", () => console.log("Connected"));
session.on("message", (msg) => console.log("Received:", msg));
session.on("error", (err) => console.error("Error:", err));
session.on("close", () => console.log("Disconnected"));

session.send("hello");

// Close when done
session.close();
```

### Node Filtering

Target specific proxy nodes for WebSocket sessions:

```ts
const auth = await client.requestToken({
  model: "hybrid",
  minutes: 10,
  megabytes: 100,
  nodeRegion: "eu-west",
  nodeExclude: "node.example.com",
});
```

### Reconnection

Sessions reconnect automatically on unexpected disconnects. When reconnecting, `SocketClient` re-requests a fresh token using the same parameters from the last `requestToken()` call and re-establishes the WebSocket connection. Set `reconnectIntervalMs` to control retry pacing.

To stop reconnection, call `session.close()` — this sets an internal flag that suppresses all automatic retries.

### Safe Mode

Both `requestToken()` and `connect()` support a `{ safe: true }` option that catches errors and returns a result object instead of throwing:

```ts
const result = await client.requestToken({ model: "time", minutes: 1 }, { safe: true });

if (!result.ok) {
  console.error("Token request failed:", result.error);
} else {
  const session = await client.connect(result.data);
}
```

### Session State

```ts
const state = session.getState();
// { connected: boolean, reconnecting: boolean, closedByCaller: boolean }
```

---

## CLI Commands

| Command | Description |
|---|---|
| `consensus setup` | Create a wallet and register it with the x402 proxy. |
| `consensus setup --force` | Force re-create the account, resetting any existing configuration. |
| `consensus help` | Show help message. |

---

## Setup Process

Run `consensus setup` to initialize your environment. The CLI will:

1. **Create a wallet** using your CDP credentials.
2. **Generate `.consensus-config.json`** containing your wallet and delegation credentials.
3. **Export wallet authorization** to the x402 proxy for payment delegation.
4. **Add `.consensus-config.json` to `.gitignore`** automatically to prevent accidental commits.

---

## Security

> **⚠️ Never commit `.consensus-config.json`.** It contains sensitive wallet credentials. The setup command adds it to `.gitignore` automatically, but verify this if you use a custom `.gitignore` setup.

>**DO NOT keep large amounts** in the proxy-delegated wallet - if the proxy is compromised, your delegation could be at risk.
> Only fund the wallet with amounts you're comfortable delegating for API payments.
