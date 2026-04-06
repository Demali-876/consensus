import { wrapFetchWithPayment }       from '@x402/fetch';
import { x402Client }                 from '@x402/core/client';
import { registerExactEvmScheme }     from '@x402/evm/exact/client';
import { registerExactSvmScheme }     from '@x402/svm/exact/client';
import { registerExactIcpScheme }     from '@canister-software/x402-icp/client';
import { resolveSigners, type ResolvedSigners } from './wallet.js';

type FetchFn = typeof globalThis.fetch;

/**
 * A CAIP-2 network identifier (or prefix) used to express a payment preference.
 *
 * Prefix forms — match any chain in that family:
 *   `'eip155'`  — any EVM chain (Ethereum, Base, …)
 *   `'solana'`  — any Solana cluster (mainnet, devnet, …)
 *   `'icp'`     — any ICP ledger canister
 *
 * Full CAIP-2 forms — pin to a specific chain/cluster:
 *   `'eip155:8453'`                                    — Base mainnet
 *   `'eip155:84532'`                                   — Base Sepolia
 *   `'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'`       — Solana mainnet-beta
 *   `'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'`       — Solana devnet
 *   `'icp:1:xafvr-biaaa-aaaai-aql5q-cai'`             — ICP TESTICP ledger
 *
 * When the server's 402 `accepts` list contains multiple entries, the first
 * entry whose `network` field starts with `preferNetwork` is chosen.
 * Falls back to `accepts[0]` if no match is found.
 */
export type PreferNetwork = string;

export type PaymentFetchOptions = {
  /** Pre-resolved signers — if omitted, auto-resolved from env via resolveSigners(). */
  signers?:       ResolvedSigners;
  /** Base fetch to wrap — defaults to globalThis.fetch. */
  fetch?:         FetchFn;
  /**
   * Preferred payment network family when multiple signers are available.
   * Without this the first entry in the server's `accepts` array is used.
   *
   * @example
   * // Always pay with ICP even when EVM / SVM signers are also present
   * createPaymentFetch({ preferNetwork: 'icp' })
   */
  preferNetwork?: PreferNetwork;
};

/**
 * Returns a fetch wrapper that automatically handles HTTP 402 responses.
 * Registers all schemes for which a signer is available (EVM, SVM, ICP).
 *
 * When all three signers are present and `preferNetwork` is set, the wrapper
 * will always attempt to pay on that chain family first.
 */
export async function createPaymentFetch(opts: PaymentFetchOptions = {}): Promise<FetchFn> {
  const signers   = opts.signers ?? await resolveSigners({ preferNetwork: opts.preferNetwork });
  const baseFetch = opts.fetch   ?? globalThis.fetch;

  const selector = opts.preferNetwork
    ? ((_version: number, accepts: Array<{ network: string }>) => {
        const preferred = accepts.find(r => r.network.startsWith(opts.preferNetwork!));
        return (preferred ?? accepts[0]) as typeof accepts[0];
      }) as unknown as ConstructorParameters<typeof x402Client>[0]
    : undefined;

  const client = new x402Client(selector);

  if (signers.evm) registerExactEvmScheme(client, { signer: signers.evm });
  if (signers.svm) registerExactSvmScheme(client, { signer: signers.svm });
  if (signers.icp) registerExactIcpScheme(client, { signer: signers.icp });

  return wrapFetchWithPayment(baseFetch, client) as FetchFn;
}
