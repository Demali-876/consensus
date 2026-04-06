import { privateKeyToAccount }          from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { base58 }                       from '@scure/base';
import { createIdentitySigner, type IcpSigner } from '@canister-software/x402-icp/client';
import { readFileSync }                 from 'node:fs';
import { resolve }                      from 'node:path';
import { homedir }                      from 'node:os';

export type ResolvedSigners = {
  evm?: ReturnType<typeof privateKeyToAccount>;
  svm?: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  icp?: IcpSigner;
};

type ResolveSignersOptions = {
  preferNetwork?: string;
  timeoutMs?: number;
};

function signerFamily(preferNetwork?: string): 'eip155' | 'solana' | 'icp' | null {
  if (!preferNetwork) return null;
  if (preferNetwork.startsWith('eip155')) return 'eip155';
  if (preferNetwork.startsWith('solana')) return 'solana';
  if (preferNetwork.startsWith('icp')) return 'icp';
  return null;
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolves whichever signers are available from environment variables.
 * At least one of the three env vars must be set.
 */
export async function resolveSigners(opts: ResolveSignersOptions = {}): Promise<ResolvedSigners> {
  const signers: ResolvedSigners = {};
  const targetFamily = signerFamily(opts.preferNetwork);
  const timeoutMs = opts.timeoutMs ?? 5000;

  if (process.env.CONSENSUS_EVM_KEY && (!targetFamily || targetFamily === 'eip155')) {
    try {
      const key = process.env.CONSENSUS_EVM_KEY;
      signers.evm = privateKeyToAccount(
        (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
      );
    } catch (err) {
      if (targetFamily === 'eip155') {
        throw new Error(`[Consensus] Failed to initialize EVM signer: ${(err as Error).message}`);
      }
      console.warn(`[Consensus] Skipping EVM signer: ${(err as Error).message}`);
    }
  }

  if (process.env.CONSENSUS_SVM_KEY && (!targetFamily || targetFamily === 'solana')) {
    try {
      signers.svm = await withTimeout(
        createKeyPairSignerFromBytes(base58.decode(process.env.CONSENSUS_SVM_KEY)),
        'Solana signer initialization',
        timeoutMs,
      );
    } catch (err) {
      if (targetFamily === 'solana') {
        throw new Error(`[Consensus] Failed to initialize Solana signer: ${(err as Error).message}`);
      }
      console.warn(`[Consensus] Skipping Solana signer: ${(err as Error).message}`);
    }
  }

  if (process.env.CONSENSUS_PEM_PATH && (!targetFamily || targetFamily === 'icp')) {
    try {
      const pemPath  = process.env.CONSENSUS_PEM_PATH;
      const resolved = resolve(pemPath.replace(/^~/, homedir()));
      const pem      = readFileSync(resolved, 'utf8');
      const { Secp256k1KeyIdentity } = await withTimeout(
        import('@dfinity/identity-secp256k1'),
        'ICP identity module import',
        timeoutMs,
      );
      const identity = Secp256k1KeyIdentity.fromPem(pem);
      signers.icp = await withTimeout(
        createIdentitySigner({ identity }),
        'ICP signer initialization',
        timeoutMs,
      );
    } catch (err) {
      if (targetFamily === 'icp') {
        throw new Error(`[Consensus] Failed to initialize ICP signer: ${(err as Error).message}`);
      }
      console.warn(`[Consensus] Skipping ICP signer: ${(err as Error).message}`);
    }
  }

  if (!signers.evm && !signers.svm && !signers.icp) {
    const requested = targetFamily ? ` for preferred network "${opts.preferNetwork}"` : '';
    throw new Error(
      `[Consensus] No signing credentials found${requested}.\n` +
      'Set at least one of:\n' +
      '  CONSENSUS_EVM_KEY   — hex EVM private key (0x-prefix optional)\n' +
      '  CONSENSUS_SVM_KEY   — base58 Solana keypair\n' +
      '  CONSENSUS_PEM_PATH  — path to PEM-encoded ICP/Ed25519 key file',
    );
  }

  return signers;
}
