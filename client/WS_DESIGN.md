# Consensus WebSocket Client Design

Status: Draft (stateful abstraction)

## Goal

Abstract WS complexity behind one client:

- token request
- token-based connect
- send/close on an active socket

User experience target:

```js
import { consensusSocketClient } from "@canister-software/consensus-cli";

const wsclient = consensusSocketClient({
  paymentFetch,
});

const token = await wsclient.requestToken({
  model: "hybrid",
  minutes: 10,
  megabytes: 100,
});

await wsclient.connect(token);
wsclient.send("hello");
```

## Existing Server Flow (unchanged)

1. `GET /ws` with query params: `model`, `minutes`, `megabytes`
2. response: `{ token, connect_url, expires_in }`
3. connect to `wss://.../ws-connect?token=...`

SDK hides this flow, but does not change it.

## Public API (V1)

```js
consensusSocketClient(options?)
```

Returns a stateful client instance with:

- `requestToken(params?)`
- `connect(tokenOrAuth)`
- `send(data)` (from session handle)
- `close(code?, reason?)` (from session handle)
- `on(event, handler)` (from session handle)
- `off(event, handler)` (from session handle)
- `getState()`

## Constructor Options

- `paymentFetch: Function`
  - payment-capable fetch (x402)
  - required
- `webSocketFactory?: WebSocket`
  - optional override for Node `ws` constructor
- `openTimeoutMs?: number`
  - default `12000`
- `reconnectIntervalMs?: number`
  - fixed reconnect interval
- `defaults?: { model?, minutes?, megabytes?, nodeRegion?, nodeDomain?, nodeExclude? }`

## `requestToken(params?)`

Input params:

- `model?: "hybrid" | "time" | "data"` (default `"hybrid"`)
- `minutes?: number` (default `5`)
- `megabytes?: number` (default `50`)
- `nodeRegion?: string`
- `nodeDomain?: string`
- `nodeExclude?: string`

Behavior:

- builds `/ws` query from params
- attaches headers:
  - `nodeRegion` -> `x-node-region`
  - `nodeDomain` -> `x-node-domain`
  - `nodeExclude` -> `x-node-exclude`
- chooses transport:
  - uses `paymentFetch`
  - throws configuration error when missing

Output:

- token response object from server:
  - `{ token, connect_url, expires_in }`

## `connect(tokenOrAuth)`

Input:

- auth object from `requestToken`:
  - `{ token, connect_url, expires_in }`
- missing token/auth throws

Behavior:

- resolves `connect_url`
- opens WS connection
- returns a connection handle
- supports multiple concurrent connections
- auto-reconnects on unexpected disconnects using fixed interval
- does not reconnect if caller explicitly closes

Output:

- session handle:
  - `send(data)`
  - `close(code?, reason?)`
  - `on(event, handler)`
  - `off(event, handler)`
  - `getState()`

## `send(data)`

Behavior:

- sent via session handle returned by `connect(...)`
- throws if socket is not open
- no pre-open queueing

## Events

`on(event, handler)` / `off(event, handler)` proxy the underlying socket events.

Common events:

- `open`
- `message`
- `close`
- `error`

## Validation Rules

- `model` must be one of `hybrid | time | data`
- `minutes` and `megabytes` must be positive integers
- invalid config/params throw typed SDK errors

## Non-Goals (V1)

- advanced session lifecycle orchestration
- custom message protocol helpers
