import { wrapFetchWithPayment }       from '@x402/fetch';
import { x402Client }                 from '@x402/core/client';
import { registerExactEvmScheme }     from '@x402/evm/exact/client';
import { registerExactSvmScheme }     from '@x402/svm/exact/client';
import { registerExactIcpScheme }     from '@canister-software/x402-icp/client';
import { resolveSigners, type ResolvedSigners } from './wallet.js';

type FetchFn = typeof globalThis.fetch;

export type PaymentFetchOptions = {
  /** Pre-resolved signers — if omitted, auto-resolved from env via resolveSigners(). */
  signers?: ResolvedSigners;
  /** Base fetch to wrap — defaults to globalThis.fetch. */
  fetch?:   FetchFn;
};

/**
 * Returns a fetch wrapper that automatically handles HTTP 402 responses.
 * Registers all schemes for which a signer is available (EVM, SVM, ICP).
 *
 * ```ts
 * // Explicit signers:
 * const fetchWithPayment = await createPaymentFetch({ signers });
 * ```
 */
export async function createPaymentFetch(opts: PaymentFetchOptions = {}): Promise<FetchFn> {
  const signers    = opts.signers ?? await resolveSigners();
  const baseFetch  = opts.fetch   ?? globalThis.fetch;
  const client     = new x402Client();

  if (signers.evm) registerExactEvmScheme(client, { signer: signers.evm });
  if (signers.svm) registerExactSvmScheme(client, { signer: signers.svm });
  if (signers.icp) registerExactIcpScheme(client, { signer: signers.icp });

  return wrapFetchWithPayment(baseFetch, client) as FetchFn;
}
