# Consensus Node

Verifiable Bun worker node runtime for the Consensus network.

This package is intentionally separate from `instance/`, which remains as a reference
implementation while this runtime is built from scratch.

## Development

```bash
bun install
bun run start
```

Default local API:

```txt
http://localhost:9090
```

State defaults to:

```txt
~/.consensus/node
```

Override with:

```bash
CONSENSUS_STATE_DIR=/path/to/state bun run start
```

## Join Flow

First run encrypted eval against the public server tunnel. A passing eval writes
`join-auth.json` into the node state directory.

```bash
CONSENSUS_STATE_DIR=~/.consensus/node \
CONSENSUS_SERVER_URL=https://consensus.canister.software \
bun run eval
```

Then register the node with the join authorization:

```bash
CONSENSUS_SERVER_URL=https://consensus.canister.software \
CONSENSUS_NODE_IPV6=... \
CONSENSUS_NODE_IPV4=... \
CONSENSUS_NODE_PORT=9090 \
CONSENSUS_NODE_TEST_ENDPOINT=https://your-node.example.com/health \
CONSENSUS_NODE_REGION=us-east-1 \
CONSENSUS_NODE_CONTACT=ops@example.com \
CONSENSUS_EVM_ADDRESS=0x... \
CONSENSUS_SOLANA_ADDRESS=... \
CONSENSUS_ICP_ADDRESS=... \
bun run register
```

After registration, keep the outbound control tunnel open:

```bash
CONSENSUS_SERVER_URL=https://consensus.canister.software \
bun run control
```

Verify the registered node code and manifest:

```bash
CONSENSUS_SERVER_URL=https://consensus.canister.software \
bun run verify
```

The verification payload signs the node release manifest with the node Ed25519
identity. The server checks that signature against the registered node key and,
when an admin-required manifest is set, compares version, platform, commit,
routes hash, and tarball SHA.

Check whether this node matches the required server release:

```bash
CONSENSUS_SERVER_URL=https://consensus.canister.software \
bun run update
```

If the server requires a newer release and the manifest includes a verified
artifact URL, download it into the node state directory:

```bash
CONSENSUS_SERVER_URL=https://consensus.canister.software \
bun run update -- --download
```

## Release Build

Build a node artifact and matching server admin manifest payload:

```bash
bun run release -- \
  --version 0.1.0-alpha.0 \
  --commit "$(git rev-parse HEAD)" \
  --download-url https://consensus.canister.software/releases/consensus-node-0.1.0-alpha.0-darwin-arm64.tgz
```

The command writes the tarball, manifest, and `/admin/manifest` payload into
`dist/`. Upload the tarball to the `download_url`, then post the admin payload
to the Pi server with `x-admin-key`.
