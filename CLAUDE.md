# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is the **Consensus Protocol** orchestrator/proxy — the `server/` package that runs at the network edge (port 8080).

The protocol spans three repositories:

- **`consensus`** (this repo) — `server/`, the orchestrator/proxy.
- **[`consensus-client`](https://github.com/Demali-876/consensus-client)** — `@canister-software/consensus-cli`, the TypeScript SDK + CLI that talks to the server. (Formerly `client/` in this repo; extracted to its own repo with full history.)
- **[`consensus-node`](https://github.com/Demali-876/consensus-node)** — the Bun worker-node runtime that registers with the orchestrator and serves proxied requests.

Everything else in the repo root (`instance/`, `x402-proxy/`, `scripts/`, `assets/`, `test-server.ts`) is out of scope for this guide.

**Canonical cross-repo reference:** the architecture + cross-repo contracts live in `consensus-docs` → https://docs.consensus.canister.software/protocol/architecture/ ([source](https://github.com/canister-software/consensus-docs/blob/main/src/content/docs/protocol/architecture.md)). Read it before changing anything that crosses a repo boundary — the `/proxy` request/response shapes, routing/caching headers, node-tunnel frames, or the routing-ticket format. Related repos: [`consensus-client`](https://github.com/Demali-876/consensus-client) (SDK + TUI/CLI), [`consensus-node`](https://github.com/Demali-876/consensus-node) (worker-node runtime), [`consensus-docs`](https://github.com/canister-software/consensus-docs) (docs site, owns the canonical reference).

## Commands

### Root (lint/format only)

```bash
npm run lint           # eslint .
npm run lint:fix       # eslint . --fix
npm run format         # prettier --write .
npm run format:check   # prettier --check .
```

ESLint config ignores `**/node_modules/**`, `**/dist/**`, and `ecosystem.config.js`. Prettier: 2-space, single-quote, semis, trailingComma=es5, printWidth 100.

### Server (Node + tsx ESM loader)

> **Deploy topology — do NOT launch a local server.** The production
> Consensus orchestrator runs on the user's own hardware (a Raspberry Pi at
> `69.201.60.251` / `consensus.canister.software`). The user manages start
> / restart manually on that box; spinning up a duplicate locally just
> creates port collisions and forks state. Workflow for server changes:
> edit → run the test suite (`cd server && npm test`) → commit → user pulls
> + restarts on the Pi. Local-only exception: the pen tests and any
> deliberately scoped dev script.

```bash
cd server
npm start              # dotenvx run -- node --import tsx/esm server.js  (production only)
npm test               # full local test suite — see "Tests" below
```

Server entry is `server.js` (ESM, `"type": "module"`); it imports `.ts` files directly via the `tsx/esm` loader, so don't introduce a separate build step.

#### Tests

`npm test` runs the dedupe pen test plus the migrated node:test suites
(`detector`, `proxy`, `reverse-proxy`, `security`). They mock at the axios
adapter level via `ConsensusProxy({ ssrfCheck: noSsrf })` — the `noSsrf`
helper lives in `server/utils/tests/_test-helpers.ts` and returns a
synthetic `SafeResolution` with `isLiteral: true` so localhost upstreams
aren't blocked. `npm run test:dedupe` for just the pen test;
`npm run test:all` adds `wss.test.ts` and `security-perf.test.ts` which
have pre-existing failures (wss: `isPrivateTarget` isn't injectable yet;
security-perf: imports `@dotenvx/dotenvx` via a path that doesn't resolve
from `x402-proxy/`).

Required env in `server/.env` (loaded by `@dotenvx/dotenvx`):

- `FACILITATOR_URL`, `EVM_PAY_TO`, `SOLANA_PAY_TO`, `ICP_PAY_TO` — required unless `FREE_MODE=true`
- `NODE_DB_PATH` (defaults to `consensus.db` in cwd), `NODE_DB_ENCRYPTION_KEY`
- `SERVER_PUBLIC_IPS` — comma-separated list of this host's own IPs/hostnames; the SSRF guard blocks targets that resolve to these
- `CONSENSUS_NODE_AUTO_UPDATES=true` to enable router-driven node updates
- `ADMIN_KEY` for `/update/*` admin routes
- Email-verification vars (asserted at boot — see `utils/email-verification.ts`)

`ecosystem.config.js` is a PM2 manifest for production deploy; ignore unless changing prod runtime.

### Client (separate repo)

The SDK + CLI now lives in **[`consensus-client`](https://github.com/Demali-876/consensus-client)** (`@canister-software/consensus-cli`, Bun ≥ 1.3) — it is no longer part of this repo. When a server change alters the `/proxy` request/response shape or the routing/caching headers, update the client repo in lockstep (see "Cross-repo contracts" below).

## Architecture

### Direction (in progress): direct client → node data plane

The proxy and tunnel **data paths are being migrated** so the orchestrator becomes a **control plane only** — it authenticates, charges (x402), selects a node, and issues a short-lived **signed ticket** — while the client connects **directly to the chosen node** for the actual request/stream. The orchestrator serves a request itself only when no other node is available (server-as-node fallback). Per-node caches replace the central cache; the server keeps sticky-by-dedupe-key routing so repeat requests reuse the same node. SSRF enforcement moves into the node runtime. **Until that lands, the flows described below (server relays everything over the control tunnel) remain current.**

### Server: the deduplication proxy

[server/server.js](server/server.js) wires together every feature. Read it first when orienting — every subsystem hangs off the `app` and `server` it constructs:

1. **`POST /proxy` flow** ([server/server.js:145](server/server.js:145)):
   - Pre-payment middleware: compute the dedupe key, return cached response immediately if hit (no x402 charge).
   - `paymentMiddleware` from `@x402/express` enforces x402 unless `FREE_MODE=true`. Three networks are accepted: Base Sepolia EVM, Solana Devnet, ICP testnet — each registered on `x402ResourceServer` with its own scheme.
   - Post-payment handler hands off to `ConsensusProxy.handleRequest`.

2. **Dedupe key** ([server/features/proxy/proxy.ts](server/features/proxy/proxy.ts)): SHA-256 over a canonical `{ scope, method, canonicalUrl, semanticHeaders, bodyHash }`. `scope` is hashed from `x-api-key` (or `"global"` when absent). Body objects use stable-stringify. Cache TTL is clamped to `[1, 3600]` seconds.

3. **`Router`** ([server/router.ts](server/router.ts)): selects a downstream node per request. Strategy: sticky-by-dedupe-key (10 min TTL) → otherwise **power-of-two-choices** by combined HTTP + WS load. Filters by `x-node-region` / `x-node-domain` / `x-node-exclude` headers. Excludes nodes whose `capabilities.update_state` is in the update lifecycle. Falls back to executing the request directly on the server if no node is eligible.

4. **Node tunnel** ([server/features/node-tunnel/](server/features/node-tunnel/)): encrypted bidirectional WS channel between server and each registered node. Two modes:
   - `eval` — onboarding: server runs benchmarks/handshake before issuing a join nonce ([orchestrator.js](server/features/nodes/orchestrator.js))
   - `control` — long-lived: server pushes proxy work onto the node and reads back responses
   Frames are sealed with **chacha20-poly1305** ([secure-channel.ts](server/features/node-tunnel/secure-channel.ts)); the handshake derives sendKey/receiveKey via HKDF and verifies the node's Ed25519 identity. Frame layout in [frames.ts](server/features/node-tunnel/frames.ts).

5. **User tunnels** ([server/features/tunnel/tunnel.ts](server/features/tunnel/tunnel.ts)): a separate WS-based mux that lets a logged-in client expose a local HTTP or TCP service through a `<slug>.<host>` subdomain. Frame opcodes (`STREAM_OPEN/DATA/END/RESET/PING/PONG`) are defined inline. TCP tunnels listen on port 20000.

6. **Paid WebSockets** ([server/features/websocket/wss.ts](server/features/websocket/wss.ts)): the `/ws` upgrade is gated by x402; pricing presets `TIME` / `DATA` / `HYBRID` are computed per session from `?model=…&minutes=…&megabytes=…` query params.

7. **SSRF guard** ([server/utils/ssrf.ts](server/utils/ssrf.ts)): every outbound proxy target is resolved once, checked against private/loopback ranges and `SERVER_PUBLIC_IPS`, then the URL is **rewritten to the resolved IP** with the original hostname kept only for `Host:` and TLS SNI. This closes the DNS-rebinding TOCTOU window — never bypass it when adding new outbound paths. (This module is the one being ported into the `consensus-node` runtime for the direct data plane.)

8. **IP pool / observation** ([server/features/ip-pool/](server/features/ip-pool/)): a scheduler periodically observes each node's claimed IPv4/IPv6, ages them with a strike system, and persists history.

9. **Persistence** ([server/data/node_store.js](server/data/node_store.js)): `better-sqlite3` in WAL mode. Tables: `nodes`, `heartbeats`, `join_requests`, `release_manifests`. The file auto-migrates by dropping old-schema tables on startup — there are no migration files. Loopback-only admin routes use the `requireLoopback` middleware ([orchestrator.js:11](server/features/nodes/orchestrator.js:11)).

10. **Updater** ([server/updater.ts](server/updater.ts)): hosts release manifests and (when `CONSENSUS_NODE_AUTO_UPDATES=true`) orchestrates one-at-a-time node updates by coordinating with `Router` and `nodeTunnel` to drain a node before applying.

The `health` endpoint at `/health` aggregates stats from proxy, websocket, tunnel, node-tunnel, and router — it's the fastest way to confirm subsystems are wired correctly after changes.

### Cross-repo contracts

These bind the `server/` here to the **[`consensus-client`](https://github.com/Demali-876/consensus-client)** and **[`consensus-node`](https://github.com/Demali-876/consensus-node)** repos — change both sides together.

- The CLI publishes to npm as `@canister-software/consensus-cli` (built with Bun's bundler to ESM + CJS + `.d.ts`); it lives in its own repo now, so coordinate releases when the server contract changes.
- `/proxy` server response shape (`{ status, statusText, data, meta }`, or full `ProxyResponse` when `x-verbose: true`) is consumed by the client; change them together.
- Server expects the following client-controlled headers to influence routing/caching, all stripped from the upstream request: `x-cache-ttl`, `x-verbose`, `x-api-key`, `x-idempotency-key`, `x-node-region`, `x-node-domain`, `x-node-exclude`. The full strip list is in [proxy.ts:90](server/features/proxy/proxy.ts:90).
- The node tunnel handshake/frame/message formats ([server/features/node-tunnel/](server/features/node-tunnel/)) are mirrored by `consensus-node`'s `src/tunnel/` + `src/crypto/`; the ticket/signing primitives for the direct data plane will be a new shared contract across both.

## Conventions

- Server: ESM, mixed `.js` and `.ts` imported with `.ts` extensions intact — the tsx loader handles them. New files should follow the same pattern; don't add a `tsconfig` build step.
- `console.log`/`console.error` is fine in server code (lint allows it). For structured logs in the server use `import { log } from './utils/log.ts'`.
- `any` is a lint warning, not an error — but the existing code threads through several `as any` casts for the `NodeStore` and tunnel layers; match the surrounding style rather than re-typing on the way through.
