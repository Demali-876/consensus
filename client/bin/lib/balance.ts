/**
 * balance.ts — resolve wallet balance for a single CAIP-2 network.
 * Used by the WebSocket setup screen (and anywhere else needing a quick per-network balance).
 */

// ── EVM ───────────────────────────────────────────────────────────────────────

const ERC20_BALANCE_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs:  [{ name: 'account', type: 'address' }],
  outputs: [{ name: '',        type: 'uint256'  }],
}] as const;

const EVM_USDC: Record<number, `0x${string}`> = {
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

async function evmClient(chainId: number) {
  const { createPublicClient, http } = await import('viem');
  const chains = await import('viem/chains');
  const map: Record<number, any> = {
    1: chains.mainnet, 8453: chains.base, 84532: chains.baseSepolia, 11155111: chains.sepolia,
  };
  const chain = map[chainId];
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  return createPublicClient({ chain, transport: http() });
}

async function evmAddress(key: string): Promise<`0x${string}` | null> {
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    return privateKeyToAccount(
      (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
    ).address;
  } catch { return null; }
}

async function evmEthBalance(addr: `0x${string}`, chainId: number): Promise<string> {
  const { formatEther } = await import('viem');
  const client = await evmClient(chainId);
  const bal = await client.getBalance({ address: addr });
  return `${parseFloat(formatEther(bal)).toFixed(6)} ETH`;
}

async function evmUsdcBalance(addr: `0x${string}`, chainId: number, usdcAddr: `0x${string}`): Promise<string> {
  const { formatUnits } = await import('viem');
  const client = await evmClient(chainId);
  const bal = await client.readContract({
    address: usdcAddr, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [addr],
  }) as bigint;
  return `${parseFloat(formatUnits(bal, 6)).toFixed(2)} USDC`;
}

// ── SVM ───────────────────────────────────────────────────────────────────────

const SVM_NET: Record<string, { rpc: string; usdcMint: string }> = {
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': {
    rpc: 'https://api.devnet.solana.com',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    rpc: 'https://api.mainnet-beta.solana.com',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

async function svmAddress(key: string): Promise<string | null> {
  try {
    const { createKeyPairSignerFromBytes } = await import('@solana/signers');
    const { base58 } = await import('@scure/base');
    const signer = await createKeyPairSignerFromBytes(base58.decode(key));
    return signer.address;
  } catch { return null; }
}

async function svmUsdcBalance(addr: string, rpc: string, usdcMint: string): Promise<string> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [addr, { mint: usdcMint }, { encoding: 'jsonParsed' }],
    }),
  });
  const data = await res.json() as {
    result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> };
  };
  const accounts = data?.result?.value ?? [];
  const amount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  return `${Number(amount).toFixed(2)} USDC`;
}

// ── ICP ───────────────────────────────────────────────────────────────────────

const ICP_FALLBACK: Record<string, string> = {
  'xafvr-biaaa-aaaai-aql5q-cai': 'TESTICP',
  'cngnf-vqaaa-aaaar-qag4q-cai': 'ckUSDC',
  'xevnm-gaaaa-aaaar-qafnq-cai': 'ckETH',
  'ryjl3-tyaaa-aaaaa-aaaba-cai': 'ICP',
  '3jkp5-oyaaa-aaaaj-azwqa-cai': 'ckUSDT',
};

const icrc1Idl = ({ IDL }: { IDL: any }) => IDL.Service({
  icrc1_balance_of: IDL.Func(
    [IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
    [IDL.Nat], ['query'],
  ),
  icrc1_symbol:   IDL.Func([], [IDL.Text], ['query']),
  icrc1_decimals: IDL.Func([], [IDL.Nat8], ['query']),
});

async function icpBalance(pemPath: string, canisterId: string): Promise<string> {
  const { readFileSync }            = await import('node:fs');
  const { resolve: resolvePath }    = await import('node:path');
  const { homedir }                 = await import('node:os');
  const { Secp256k1KeyIdentity }    = await import('@dfinity/identity-secp256k1');
  const { HttpAgent, Actor }        = await import('@dfinity/agent');

  const pem      = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
  const identity = Secp256k1KeyIdentity.fromPem(pem);
  const agent    = HttpAgent.createSync({ host: 'https://ic0.app', identity, fetch: globalThis.fetch.bind(globalThis) });
  const owner    = identity.getPrincipal();
  const fallback = ICP_FALLBACK[canisterId] ?? canisterId.slice(0, 8);

  const ledger = Actor.createActor(icrc1Idl, { agent, canisterId }) as {
    icrc1_balance_of(a: { owner: unknown; subaccount: never[] }): Promise<bigint>;
    icrc1_symbol(): Promise<string>;
    icrc1_decimals(): Promise<number>;
  };
  const [balance, symbol, decimals] = await Promise.all([
    ledger.icrc1_balance_of({ owner, subaccount: [] }),
    ledger.icrc1_symbol(),
    ledger.icrc1_decimals(),
  ]);
  const sym = (symbol || fallback).trim();
  const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 8;
  return `${(Number(balance) / 10 ** dec).toFixed(4)} ${sym}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the wallet balance for a single CAIP-2 network identifier.
 * Returns a formatted string like "1.23 USDC" or "0.000042 ETH".
 * Returns '—' for the auto network ('') or unknown networks.
 */
export async function resolveNetworkBalance(caip2: string): Promise<string> {
  if (!caip2) return '—';

  const evmKey  = process.env.CONSENSUS_EVM_KEY;
  const svmKey  = process.env.CONSENSUS_SVM_KEY;
  const pemPath = process.env.CONSENSUS_PEM_PATH;

  try {
    if (caip2.startsWith('eip155:')) {
      if (!evmKey) return 'no EVM key';
      const chainId = parseInt(caip2.split(':')[1]!, 10);
      const addr = await evmAddress(evmKey);
      if (!addr) return 'invalid key';
      const usdcAddr = EVM_USDC[chainId];
      return usdcAddr
        ? evmUsdcBalance(addr, chainId, usdcAddr)
        : evmEthBalance(addr, chainId);
    }

    if (caip2.startsWith('solana:')) {
      if (!svmKey) return 'no SVM key';
      const net = SVM_NET[caip2];
      if (!net) return '—';
      const addr = await svmAddress(svmKey);
      if (!addr) return 'invalid key';
      return svmUsdcBalance(addr, net.rpc, net.usdcMint);
    }

    if (caip2.startsWith('icp:')) {
      if (!pemPath) return 'no ICP key';
      const canisterId = caip2.split(':')[2];
      if (!canisterId) return '—';
      return icpBalance(pemPath, canisterId);
    }
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 40) : '(error)';
  }

  return '—';
}
