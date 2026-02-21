# Consensus Server SDK Design (HTTP First)

Status: Draft (locked decisions for HTTP middleware)

## Goal

Give HTTP servers a simple way to route outbound `fetch` calls through Consensus proxy/x402 payment flow without handcrafting payloads.

Primary integration should be middleware-first:

```js
app.use(consensusProxy(fetchWithPayment, options));
```

## Non-Goals (for this phase)

- Browser-first API design
- WebSocket API details (next design phase)
- Non-`fetch` interception (`axios`, `http.request`) in V1

## Public API (V1)

```js
consensusProxy(fetchWithPayment, options?)
```

- `fetchWithPayment`: required payment-capable fetch function
- `options`: optional behavior + header defaults

### Options

- `mode?: "inclusive" | "exclusive"`
  - Default: `"inclusive"`
- `routes?: string[]`
  - Path matcher list (simple route strings, e.g. `"/health"`)
- `matchSubroutes?: boolean`
  - Default: `false`
  - `false`: exact route matching
  - `true`: prefix-based route matching
- `strategy?: "auto" | "manual"`
  - Default: `"auto"`
  - `auto`: middleware intercepts route-matched outbound `fetch`
  - `manual`: middleware does not intercept global `fetch`; exposes `req.consensus.fetch`
- `cache_ttl?: number`
  - Sent as `x-cache-ttl`
- `verbose?: boolean`
  - Sent as `x-verbose`
- `node_region?: string`
  - Sent as `x-node-region`
- `node_domain?: string`
  - Sent as `x-node-domain`
- `node_exclude?: string`
  - Sent as `x-node-exclude`

## Route Matching Semantics

Route matching uses `req.path` only.

- Query params are ignored.
- Trailing slash is normalized (except root `/`).
  - `"/route"` and `"/route/"` are equivalent.

### Normalization

`normalizePath(path)`:

- If path is `/`, return `/`
- Else remove trailing slashes

### Match Rules

Given normalized request path `P` and route `R`:

- Exact mode (`matchSubroutes=false`):
  - Match when `P === R`
- Subroute mode (`matchSubroutes=true`):
  - Match when `P === R` OR `P.startsWith(R + "/")`

### Inclusion/Exclusion Rules

- `mode: "inclusive"`:
  - Apply proxy to all routes **except** matched routes
- `mode: "exclusive"`:
  - Apply proxy to no routes **except** matched routes

## Header Mapping

When a request is proxied, SDK injects these proxy-control headers into the payload:

- `cache_ttl` -> `x-cache-ttl`
- `verbose` -> `x-verbose`
- `node_region` -> `x-node-region`
- `node_domain` -> `x-node-domain`
- `node_exclude` -> `x-node-exclude`

This aligns with the server proxy behavior in `/Users/user/Desktop/consensus/server/proxy.js`.

## Execution Strategy

### `strategy: "auto"` (default)

- For matched routes, middleware routes outbound `fetch` through Consensus transport automatically.
- Existing handler code can continue calling `fetch(...)`.
- For non-matched routes, use original fetch behavior.

### `strategy: "manual"`

- Middleware never patches/intercepts global fetch.
- Middleware attaches a scoped API:
  - `req.consensus.fetch(...)`
  - `req.consensus.request(...)` (raw payload form)
- Handler opts in explicitly per call.

## Endpoint Resolution

User should not have to pass server/proxy URLs in middleware options.

- Transport endpoints are resolved internally by SDK defaults/config.

## Examples

### Inclusive + exact matching (default)

```js
app.use(
  consensusProxy(fetchWithPayment, {
    mode: "inclusive",
    routes: ["/health"], // everything proxied except /health
  })
);
```

### Exclusive + exact matching

```js
app.use(
  consensusProxy(fetchWithPayment, {
    mode: "exclusive",
    routes: ["/ai/infer"], // only this path proxied
  })
);
```

### Exclusive + subroute matching

```js
app.use(
  consensusProxy(fetchWithPayment, {
    mode: "exclusive",
    routes: ["/ai"],
    matchSubroutes: true, // /ai and /ai/*
  })
);
```

### Manual strategy

```js
app.use(consensusProxy(fetchWithPayment, { strategy: "manual" }));

app.get("/price", async (req, res) => {
  const response = await req.consensus.fetch("https://api.example.com/price");
  res.json(await response.json());
});
```

## Next Phase

Design WebSocket API with the same principles:

- middleware-first ergonomics
- explicit control over routing and payment behavior
- minimal required configuration
