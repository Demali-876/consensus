# Proxy Profile Protocol

`profile-v1` is an anonymous execution contract carried with a proxy request. A profile name is SDK-local and never identifies a user; the wire plan contains only versioned policy and execution controls.

## Required invariants

- The wire schema and conformance vectors remain identical across `consensus`, `consensus-client`, and `consensus-node`.
- Each runtime uses one profile-preparation operation to normalize, enforce, hash, and apply the plan; transport layers only carry the resulting wire shape.
- The canonical profile hash is included in the request dedupe key and therefore in direct-routing ticket binding.
- Profiles are part of the forward-proxy request protocol, not a node capability; every forward-proxy execution path handles them.
- The main server is the compatibility fallback and must implement a profile feature before the client can emit it.
- A client profile may constrain execution or provide bounded hints, but it cannot weaken SSRF checks, header stripping, TTL limits, or other platform security policy.

## Feature rollout

1. Extend the canonical server contract and shared vectors.
2. Mirror validation and execution in every node forward-proxy path.
3. Retain identical main-server fallback behavior without capability-based routing.
4. Mirror the contract in the SDK and add client emission only after both execution paths exist.
5. Test client-to-server transport, server fallback, relayed node execution, direct ticket binding, and node execution.
6. Enable by default only after mixed-version deployments have been exercised; remove compatibility behavior in a later protocol version.
