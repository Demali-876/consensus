// Direct-routing response: the orchestrator selects a node, signs a routing
// ticket bound to {node_id, dedupe_key}, and hands the client everything it
// needs to connect straight to that node — the node's domain and its Ed25519
// identity key (so the client can pin it during the responder-auth handshake)
// plus the ticket the node verifies against the orchestrator key it pinned at
// registration. This is the server side of the control/data-plane split; the
// orchestrator no longer relays or fetches in this path.

import crypto from 'node:crypto';
import { issueTicket } from '../tickets/ticket.ts';
import type { OrchestratorKey } from '../tickets/keys.ts';

// Long enough for the client to open the connection, run the handshake, and send
// the request; short enough to bound a leaked ticket's window.
const DEFAULT_TICKET_TTL_SEC = 120;

export interface NodeRoute {
  node_id:         string;
  domain:          string;
  connect_url:     string;
  node_pubkey_pem: string;
  ticket:          string;
  dedupe_key:      string;
  ticket_exp:      number;
}

/** Convert a stored Ed25519 public key (DER SPKI) into PEM for the client. */
export function nodePublicKeyPem(der: Buffer | Uint8Array): string {
  const key = crypto.createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('node public key is not Ed25519');
  }
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/** Build the routing response for a selected node: a ticket bound to
 *  {node_id, dedupe_key} plus the node's connection info. Pure and deterministic
 *  when `jti`/`now` are supplied (for tests/vectors). */
export function buildNodeRoute(params: {
  node:          { id: string; domain?: string | null };
  nodePubkeyDer: Buffer | Uint8Array;
  dedupeKey:     string;
  key:           OrchestratorKey;
  ttlSec?:       number;
  jti?:          string;
  now?:          number;
}): NodeRoute {
  if (!params.node.domain) throw new TypeError('selected node has no domain');

  const now    = params.now ?? Math.floor(Date.now() / 1000);
  const ttlSec = params.ttlSec ?? DEFAULT_TICKET_TTL_SEC;
  const jti    = params.jti ?? crypto.randomUUID();

  const ticket = issueTicket(
    { nodeId: params.node.id, dedupeKey: params.dedupeKey, jti, ttlSec, now },
    params.key.privateKey,
    params.key.kid,
  );

  return {
    node_id:         params.node.id,
    domain:          params.node.domain,
    connect_url:     `wss://${params.node.domain}/connect`,
    node_pubkey_pem: nodePublicKeyPem(params.nodePubkeyDer),
    ticket,
    dedupe_key:      params.dedupeKey,
    ticket_exp:      now + ttlSec,
  };
}
