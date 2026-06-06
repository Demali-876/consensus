import { privateKeyToAccount } from 'viem/accounts';
import type { Chain } from 'viem';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { base58 } from '@scure/base';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

const ERC20_BALANCE_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

const icrc1Idl = ({ IDL }: { IDL: any }) => IDL.Service({
  icrc1_balance_of: IDL.Func(
    [IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
    [IDL.Nat], ['query'],
  ),
  icrc1_symbol: IDL.Func([], [IDL.Text], ['query']),
  icrc1_decimals: IDL.Func([], [IDL.Nat8], ['query']),
});

export async function resolveEvmAddress(privateKey: string): Promise<`0x${string}` | '(invalid key)'> {
  try {
    return privateKeyToAccount(
      (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`,
    ).address;
  } catch {
    return '(invalid key)';
  }
}

async function getEvmClient(chainId: number) {
  const { createPublicClient, http } = await import('viem');
  const chains = await import('viem/chains');
  const map: Record<number, Chain> = {
    1: chains.mainnet,
    8453: chains.base,
    84532: chains.baseSepolia,
    11155111: chains.sepolia,
  };
  const chain = map[chainId];
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({ chain, transport: http() });
}

export async function resolveEvmEthBalance(address: `0x${string}`, chainId: number): Promise<string> {
  try {
    const { formatEther } = await import('viem');
    const client = await getEvmClient(chainId);
    const bal = await client.getBalance({ address });
    return `${parseFloat(formatEther(bal)).toFixed(6)} ETH`;
  } catch {
    return '—';
  }
}

export async function resolveEvmUsdcBalance(
  address: `0x${string}`,
  chainId: number,
  usdcAddress: `0x${string}`,
): Promise<string> {
  try {
    const { formatUnits } = await import('viem');
    const client = await getEvmClient(chainId);
    const bal = await client.readContract({
      address: usdcAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address],
    }) as bigint;
    return `${parseFloat(formatUnits(bal, 6)).toFixed(2)} USDC`;
  } catch {
    return '—';
  }
}

export async function resolveSvmAddress(privateKey: string): Promise<string> {
  try {
    const signer = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    return signer.address;
  } catch {
    return '(invalid key)';
  }
}

export async function resolveSvmSolBalance(address: string, rpcUrl: string): Promise<string> {
  try {
    const { createSolanaRpc } = await import('@solana/rpc');
    const result = await (createSolanaRpc(rpcUrl).getBalance as Function)(address).send();
    const lamports: bigint =
      result !== null && typeof result === 'object' && 'value' in result
        ? (result as { value: bigint }).value
        : (result as bigint);
    return `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
  } catch {
    return '—';
  }
}

export async function resolveSvmUsdcBalance(address: string, rpcUrl: string, usdcMint: string): Promise<string> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [address, { mint: usdcMint }, { encoding: 'jsonParsed' }],
      }),
    });
    const data = await res.json() as {
      result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> };
    };
    const amount = data.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return `${Number(amount).toFixed(2)} USDC`;
  } catch {
    return '—';
  }
}

export async function resolveIcpPrincipal(pemPath: string): Promise<string> {
  try {
    const pem = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
    const { Secp256k1KeyIdentity } = await import('@dfinity/identity-secp256k1');
    return Secp256k1KeyIdentity.fromPem(pem).getPrincipal().toText();
  } catch {
    return '(invalid PEM)';
  }
}

export async function resolveIcpCanisterBalance(
  Actor: any,
  agent: unknown,
  principal: unknown,
  canisterId: string,
  fallback: string,
): Promise<{ symbol: string; formatted: string }> {
  try {
    const ledger = Actor.createActor(icrc1Idl, { agent, canisterId }) as {
      icrc1_balance_of(a: { owner: unknown; subaccount: never[] }): Promise<bigint>;
      icrc1_symbol(): Promise<string>;
      icrc1_decimals(): Promise<number>;
    };
    const [balance, symbol, decimals] = await Promise.all([
      ledger.icrc1_balance_of({ owner: principal, subaccount: [] }),
      ledger.icrc1_symbol(),
      ledger.icrc1_decimals(),
    ]);
    const sym = (symbol || fallback).trim();
    const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 8;
    return { symbol: sym, formatted: `${(Number(balance) / 10 ** dec).toFixed(4)}` };
  } catch {
    return { symbol: fallback, formatted: '—' };
  }
}
