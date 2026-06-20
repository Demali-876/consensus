// Publishes the orchestrator's public signing key as a JWKS document at
// GET /orchestrator/pubkey, so nodes (and anyone) can verify routing tickets.
// Read-only and additive. Degrades to 503 if the signing key isn't configured,
// so registering this never risks the server boot.

import type { Express } from 'express';
import { getOrchestratorKey, publicJwk, type OrchestratorKey } from './keys.ts';

export interface PubkeyResult {
  status: number;
  body: unknown;
}

/** Pure builder: a JWKS (200) from the key getter, or 503 if it isn't available. */
export function orchestratorPubkeyResponse(getKey: () => OrchestratorKey): PubkeyResult {
  let key: OrchestratorKey;
  try {
    key = getKey();
  } catch {
    return { status: 503, body: { error: 'orchestrator signing key unavailable' } };
  }
  return { status: 200, body: { keys: [publicJwk(key.publicKey, key.kid)] } };
}

export interface OrchestratorPin {
  /** Public JWK the node pins at registration, or null if no key is configured. */
  orchestrator_pubkey: Record<string, string> | null;
}

/** The pinned-key block to embed in a node-join response. Lets a node pin the
 *  orchestrator's verification key at registration instead of trusting whatever
 *  is served at request time. Never throws: if the signing key isn't configured
 *  the node simply registers without a pinned key (and falls back to the
 *  published JWKS), so this can't break the join flow. */
export function orchestratorPinForJoin(getKey: () => OrchestratorKey = getOrchestratorKey): OrchestratorPin {
  try {
    const key = getKey();
    return { orchestrator_pubkey: publicJwk(key.publicKey, key.kid) };
  } catch {
    return { orchestrator_pubkey: null };
  }
}

export function registerOrchestratorKey(
  app: Express,
  options: { getKey?: () => OrchestratorKey } = {},
): void {
  const getKey = options.getKey ?? getOrchestratorKey;
  app.get('/orchestrator/pubkey', (_req, res) => {
    const { status, body } = orchestratorPubkeyResponse(getKey);
    res.status(status).json(body);
  });
}
