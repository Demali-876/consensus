// Routing ticket schema — the claims the orchestrator signs and the node
// verifies. Wraps the PASETO v4.public core (./paseto.ts).
//
// Bindings:
//   - aud   = node_id        (which node may accept it; also bound as the
//                             PASETO implicit assertion for defense in depth)
//   - sub   = dedupe_key     (request binding; the node recomputes and compares)
//   - scope = "proxy"        (ticket purpose)
//   - jti                    (single-use id; the node tracks it until exp)
//   - kid carried in the footer for key rotation.

import type { KeyObject } from 'node:crypto';
import { signV4Public, verifyV4Public } from './paseto.ts';

export const TICKET_ISSUER = 'consensus-orchestrator';
export const TICKET_SCOPE_PROXY = 'proxy';
const DEFAULT_TTL_SEC = 60;
const DEFAULT_CLOCK_TOLERANCE_SEC = 5;

export interface TicketClaims {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface IssueTicketInput {
  nodeId: string;
  dedupeKey: string;
  jti: string;
  ttlSec?: number;
  scope?: string;
  now?: number; // injectable clock (unix seconds), for tests
}

export function issueTicket(input: IssueTicketInput, secretKey: KeyObject, kid: string): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: TicketClaims = {
    iss: TICKET_ISSUER,
    aud: input.nodeId,
    sub: input.dedupeKey,
    scope: input.scope ?? TICKET_SCOPE_PROXY,
    iat: now,
    exp: now + (input.ttlSec ?? DEFAULT_TTL_SEC),
    jti: input.jti,
  };
  // node_id is also the implicit assertion: a ticket cannot even pass signature
  // verification at the wrong node, independent of the aud claim check.
  return signV4Public(JSON.stringify(claims), secretKey, JSON.stringify({ kid }), input.nodeId);
}

export interface VerifyTicketOptions {
  expectedNodeId: string;
  expectedScope?: string;
  now?: number;
  clockToleranceSec?: number;
}

export interface VerifiedTicket {
  claims: TicketClaims;
  kid: string | null;
}

export function verifyTicket(
  token: string,
  publicKey: KeyObject,
  opts: VerifyTicketOptions,
): VerifiedTicket {
  // Implicit assertion must equal this node's id, or the signature check fails.
  const { message, footer } = verifyV4Public(token, publicKey, opts.expectedNodeId);

  let claims: TicketClaims;
  try {
    claims = JSON.parse(message.toString('utf8')) as TicketClaims;
  } catch {
    throw new Error('ticket: malformed claims');
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  const scope = opts.expectedScope ?? TICKET_SCOPE_PROXY;

  if (claims.iss !== TICKET_ISSUER) throw new Error('ticket: bad issuer');
  if (claims.aud !== opts.expectedNodeId) throw new Error('ticket: audience mismatch');
  if (claims.scope !== scope) throw new Error('ticket: scope mismatch');
  if (typeof claims.exp !== 'number' || now > claims.exp + skew) throw new Error('ticket: expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + skew) throw new Error('ticket: issued in the future');
  if (typeof claims.jti !== 'string' || !claims.jti) throw new Error('ticket: missing jti');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ticket: missing subject');

  let kid: string | null = null;
  if (footer.length) {
    try {
      kid = (JSON.parse(footer.toString('utf8')) as { kid?: string }).kid ?? null;
    } catch {
      /* footer without a parseable kid — leave null */
    }
  }
  return { claims, kid };
}
