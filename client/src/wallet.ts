import { privateKeyToAccount }          from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { base58 }                       from '@scure/base';
import { pemToSigner }                  from '@canister-software/x402-icp/client';

export type ResolvedSigners = {
  evm?: ReturnType<typeof privateKeyToAccount>;
  svm?: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  icp?: Awaited<ReturnType<typeof pemToSigner>>;
};

/**
 * Resolves whichever signers are available from environment variables.
 * At least one of the three env vars must be set.
 */
export async function resolveSigners(): Promise<ResolvedSigners> {
  const signers: ResolvedSigners = {};

  if (process.env.CONSENSUS_EVM_KEY) {
    const key = process.env.CONSENSUS_EVM_KEY;
    signers.evm = privateKeyToAccount(
      (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
    );
  }

  if (process.env.CONSENSUS_SVM_KEY) {
    signers.svm = await createKeyPairSignerFromBytes(
      base58.decode(process.env.CONSENSUS_SVM_KEY),
    );
  }

  if (process.env.CONSENSUS_PEM_PATH) {
    signers.icp = await pemToSigner(process.env.CONSENSUS_PEM_PATH);
  }

  if (!signers.evm && !signers.svm && !signers.icp) {
    throw new Error(
      '[Consensus] No signing credentials found.\n' +
      'Set at least one of:\n' +
      '  CONSENSUS_EVM_KEY   — hex EVM private key (0x-prefix optional)\n' +
      '  CONSENSUS_SVM_KEY   — base58 Solana keypair\n' +
      '  CONSENSUS_PEM_PATH  — path to PEM-encoded ICP/Ed25519 key file',
    );
  }

  return signers;
}
