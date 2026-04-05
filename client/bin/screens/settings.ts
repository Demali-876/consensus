/**
 * Settings screen — wallet addresses + per-network balances for all x402 networks.
 */
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../theme';
import { loadConfig } from '../lib/config.ts';
import { privateKeyToAccount }         from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { base58 }                       from '@scure/base';
import { readFileSync }                 from 'node:fs';
import { resolve as resolvePath }       from 'node:path';
import { homedir }                      from 'node:os';

// ── Network config (x402 facilitator) ────────────────────────────────────────

const EVM_NETWORKS = [
  { chainId: 1,        label: 'Ethereum   ', usdc: null                                                         },
  { chainId: 8453,     label: 'Base       ', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}` },
  { chainId: 84532,    label: 'Base Sep   ', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}` },
  { chainId: 11155111, label: 'Eth Sep    ', usdc: null                                                         },
] as const;

const SVM_NETWORKS = [
  { rpc: 'https://api.mainnet-beta.solana.com', label: 'Mainnet    ', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { rpc: 'https://api.devnet.solana.com',       label: 'Devnet     ', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
] as const;

const ICP_CANISTERS = [
  { id: 'ryjl3-tyaaa-aaaaa-aaaba-cai', fallback: 'ICP      ' },
  { id: 'xevnm-gaaaa-aaaar-qafnq-cai', fallback: 'ckETH    ' },
  { id: 'cngnf-vqaaa-aaaar-qag4q-cai', fallback: 'ckUSDC   ' },
  { id: 'xafvr-biaaa-aaaai-aql5q-cai', fallback: 'TESTICP  ' },
  { id: '3jkp5-oyaaa-aaaaj-azwqa-cai', fallback: 'ckUSDT   ' },
] as const;

// Minimal ABI for ERC-20 balanceOf
const ERC20_BALANCE_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs:  [{ name: 'account', type: 'address' }],
  outputs: [{ name: '',        type: 'uint256'  }],
}] as const;

// ICRC-1 minimal IDL (balance + symbol + decimals)
const icrc1Idl = ({ IDL }: { IDL: any }) => IDL.Service({
  icrc1_balance_of: IDL.Func(
    [IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
    [IDL.Nat], ['query'],
  ),
  icrc1_symbol:   IDL.Func([], [IDL.Text], ['query']),
  icrc1_decimals: IDL.Func([], [IDL.Nat8], ['query']),
});

// ── EVM resolvers ─────────────────────────────────────────────────────────────

async function resolveEvmAddress(privateKey: string): Promise<`0x${string}` | '(invalid key)'> {
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
  const map: Record<number, object> = {
    1: chains.mainnet, 8453: chains.base, 84532: chains.baseSepolia, 11155111: chains.sepolia,
  };
  const chain = map[chainId];
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({ chain, transport: http() });
}

async function resolveEvmEthBalance(address: `0x${string}`, chainId: number): Promise<string> {
  try {
    const { formatEther } = await import('viem');
    const client = await getEvmClient(chainId);
    const bal = await client.getBalance({ address });
    return `${parseFloat(formatEther(bal)).toFixed(6)} ETH`;
  } catch { return '(error)'; }
}

async function resolveEvmUsdcBalance(address: `0x${string}`, chainId: number, usdcAddress: `0x${string}`): Promise<string> {
  try {
    const { formatUnits } = await import('viem');
    const client = await getEvmClient(chainId);
    const bal = await client.readContract({
      address: usdcAddress, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address],
    }) as bigint;
    return `${parseFloat(formatUnits(bal, 6)).toFixed(2)} USDC`;
  } catch { return '(error)'; }
}

// ── SVM resolvers ─────────────────────────────────────────────────────────────

async function resolveSvmAddress(privateKey: string): Promise<string> {
  try {
    const signer = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    return signer.address;
  } catch { return '(invalid key)'; }
}

async function resolveSvmSolBalance(address: string, rpcUrl: string): Promise<string> {
  try {
    const { createSolanaRpc } = await import('@solana/rpc');
    const result = await (createSolanaRpc(rpcUrl).getBalance as Function)(address).send();
    const lamports: bigint =
      result !== null && typeof result === 'object' && 'value' in result
        ? (result as { value: bigint }).value
        : (result as bigint);
    return `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
  } catch { return '(error)'; }
}

async function resolveSvmUsdcBalance(address: string, rpcUrl: string, usdcMint: string): Promise<string> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [address, { mint: usdcMint }, { encoding: 'jsonParsed' }],
      }),
    });
    const data = await res.json() as { result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> } };
    const accounts = data?.result?.value ?? [];
    if (accounts.length === 0) return '0.00 USDC';
    const amount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return `${Number(amount).toFixed(2)} USDC`;
  } catch { return '(error)'; }
}

// ── ICP resolvers ─────────────────────────────────────────────────────────────

async function resolveIcpPrincipal(pemPath: string): Promise<string> {
  try {
    const pem = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
    const { Secp256k1KeyIdentity } = await import('@dfinity/identity-secp256k1');
    return Secp256k1KeyIdentity.fromPem(pem).getPrincipal().toText();
  } catch { return '(invalid PEM)'; }
}

async function resolveIcpCanisterBalance(
  Actor:      any,
  agent:      unknown,
  principal:  unknown,
  canisterId: string,
  fallback:   string,
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
    return { symbol: sym, formatted: `${(Number(balance) / 10 ** dec).toFixed(4)} ${sym}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 50) : '(error)';
    return { symbol: fallback.trim(), formatted: msg };
  }
}

// ── Screen ────────────────────────────────────────────────────────────────────

const TITLE = 'SETTINGS';

export async function showSettings(): Promise<'back'> {
  const cfg   = loadConfig();
  const lease = cfg.leased_node;

  const evmKey  = process.env.CONSENSUS_EVM_KEY;
  const svmKey  = process.env.CONSENSUS_SVM_KEY;
  const pemPath = process.env.CONSENSUS_PEM_PATH;
  const hasWallet = evmKey || svmKey || pemPath;

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: TITLE,       fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  root.add(content);

  const ln = (text = ' ', fg = C.slate) => {
    const t = new TextRenderable(renderer, { content: text, fg, bg: C.dark });
    content.add(t);
    return t;
  };

  const row = (label: string) => {
    const r = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
    r.add(new TextRenderable(renderer, { content: label.padEnd(16), fg: C.dim, bg: 'transparent' }));
    const val = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: 'transparent' });
    r.add(val);
    content.add(r);
    return val;
  };

  /** Indented sub-row — label and value are both mutable */
  const subRow = (label: string) => {
    const r = new BoxRenderable(renderer, { flexDirection: 'row', backgroundColor: 'transparent' });
    const lRef = new TextRenderable(renderer, { content: `  ${label}`.padEnd(16), fg: C.dim, bg: 'transparent' });
    const vRef = new TextRenderable(renderer, { content: '—', fg: C.slate, bg: 'transparent' });
    r.add(lRef); r.add(vRef);
    content.add(r);
    return { lRef, vRef };
  };

  // ── Build tree ────────────────────────────────────────────────────────────

  ln(TITLE, C.white);
  ln('─'.repeat(40), C.dim);
  ln();

  if (!cfg.wallet_name && !hasWallet) {
    ln('Not set up. Run: consensus setup', C.amber);
  } else {
    const walletRef = row('Wallet name');
    ln();

    // EVM: one ETH row per network + one USDC row for supported networks
    const evmAddrRef = row('EVM');
    const evmRows = EVM_NETWORKS.map(n => ({
      chainId:     n.chainId,
      usdcAddress: n.usdc,                                         // contract address (or null)
      eth:         subRow(n.label + 'ETH '),
      usdc:        n.usdc ? subRow(n.label + 'USDC ') : null,      // row refs (or null)
    }));
    ln();

    // Solana: SOL + USDC per network
    const svmAddrRef = row('Solana');
    const svmRows = SVM_NETWORKS.map(n => ({
      rpc:      n.rpc,
      usdcMint: n.usdc,                  // mint address
      sol:      subRow(n.label + 'SOL '),
      usdc:     subRow(n.label + 'USDC '),
    }));
    ln();

    // ICP: one row per canister
    const icpAddrRef = row('ICP');
    const icpRows = ICP_CANISTERS.map(c => ({ ...c, ...subRow(c.fallback) }));
    ln();

    const proxyRef   = row('Proxy URL');
    const dateRef    = row('Setup date');
    const versionRef = row('Version');
    ln();
    const leaseRef = ln();

    // Static sync values
    walletRef.content  = cfg.wallet_name    ?? '—';
    proxyRef.content   = cfg.x402_proxy_url ?? '—';
    dateRef.content    = cfg.setup_date ? new Date(cfg.setup_date).toLocaleDateString() : '—';
    versionRef.content = cfg.version        ?? '—';
    if (lease) {
      leaseRef.content = `Leased node: ${lease.domain}${lease.region ? '  ' + lease.region : ''}`;
      leaseRef.fg = C.cyan;
    } else {
      leaseRef.content = 'Leased node:    none';
      leaseRef.fg = C.dim;
    }

    // ── Async resolution ─────────────────────────────────────────────────────

    const pend = (v: { vRef: TextRenderable }, has: boolean) => {
      v.vRef.content = has ? 'querying…' : '—';
      v.vRef.fg = C.slate;
    };
    const set = (v: { vRef: TextRenderable }, text: string) => {
      v.vRef.content = text;
      v.vRef.fg = /^\d/.test(text) ? C.cyan : C.red;
    };

    async function resolveAll(): Promise<void> {
      evmAddrRef.content = evmKey  ? 'resolving…' : '—'; evmAddrRef.fg = C.slate;
      svmAddrRef.content = svmKey  ? 'resolving…' : '—'; svmAddrRef.fg = C.slate;
      icpAddrRef.content = pemPath ? 'resolving…' : '—'; icpAddrRef.fg = C.slate;

      for (const n of evmRows) {
        pend(n.eth, !!evmKey);
        if (n.usdc) pend(n.usdc, !!evmKey);
      }
      for (const n of svmRows) { pend(n.sol, !!svmKey); pend(n.usdc, !!svmKey); }
      for (const n of icpRows) { pend(n, !!pemPath); }

      // ── EVM ────────────────────────────────────────────────────────────────
      const evmTask = evmKey ? resolveEvmAddress(evmKey).then(async (addr) => {
        evmAddrRef.content = addr;
        evmAddrRef.fg = addr === '(invalid key)' ? C.red : C.emerald;
        if (addr === '(invalid key)') {
          for (const n of evmRows) { set(n.eth, '—'); if (n.usdc) set(n.usdc, '—'); }
          return;
        }
        for (const n of evmRows) {
          resolveEvmEthBalance(addr, n.chainId).then(v => set(n.eth, v));
          if (n.usdcAddress && n.usdc) {
            resolveEvmUsdcBalance(addr, n.chainId, n.usdcAddress).then(v => set(n.usdc!, v));
          }
        }
      }) : Promise.resolve();

      // ── SVM ────────────────────────────────────────────────────────────────
      const svmTask = svmKey ? resolveSvmAddress(svmKey).then(async (addr) => {
        svmAddrRef.content = addr;
        svmAddrRef.fg = addr === '(invalid key)' ? C.red : C.emerald;
        if (addr === '(invalid key)') {
          for (const n of svmRows) { set(n.sol, '—'); set(n.usdc, '—'); }
          return;
        }
        for (const n of svmRows) {
          resolveSvmSolBalance(addr, n.rpc).then(v => set(n.sol, v));
          resolveSvmUsdcBalance(addr, n.rpc, n.usdcMint).then(v => set(n.usdc, v));
        }
      }) : Promise.resolve();

      // ── ICP ────────────────────────────────────────────────────────────────
      const icpTask = pemPath ? (async () => {
        const principal = await resolveIcpPrincipal(pemPath);
        icpAddrRef.content = principal;
        icpAddrRef.fg = principal === '(invalid PEM)' ? C.red : C.emerald;

        if (principal === '(invalid PEM)') {
          for (const n of icpRows) { set(n, '—'); }
          return;
        }

        try {
          const pem = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
          const { Secp256k1KeyIdentity } = await import('@dfinity/identity-secp256k1');
          // Import Actor in the same scope as HttpAgent — guarantees same module instance
          const { HttpAgent, Actor }     = await import('@dfinity/agent');
          const identity = Secp256k1KeyIdentity.fromPem(pem);
          // Pass fetch explicitly — Bun sets globalThis.fetch but @dfinity/agent checks global.fetch
          const agent = HttpAgent.createSync({
            host: 'https://ic0.app',
            identity,
            fetch: globalThis.fetch.bind(globalThis),
          });
          const owner    = identity.getPrincipal();

          for (let i = 0; i < ICP_CANISTERS.length; i++) {
            const { id, fallback } = ICP_CANISTERS[i];
            const n = icpRows[i];
            // Pass Actor explicitly — same instance that created the agent
            resolveIcpCanisterBalance(Actor, agent, owner, id, fallback)
              .then(({ symbol, formatted }) => {
                n.lRef.content = `  ${symbol}`.padEnd(16);
                n.vRef.content = formatted;
                n.vRef.fg      = /^\d/.test(formatted) ? C.cyan : C.red;
              });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 35) : '(agent error)';
          for (const n of icpRows) { n.vRef.content = msg; n.vRef.fg = C.red; }
        }
      })() : Promise.resolve();

      await Promise.all([evmTask, svmTask, icpTask]);
    }

    void resolveAll();

    const bottomBar = new BoxRenderable(renderer, {
      width: '100%', flexDirection: 'row', justifyContent: 'space-between',
      paddingX: 2, paddingY: 0, backgroundColor: C.panel,
    });
    bottomBar.add(new TextRenderable(renderer, { content: '[R  refresh]  [B  back]', fg: C.slate, bg: C.panel }));
    bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
    root.add(bottomBar);

    return new Promise<'back'>((resolve) => {
      renderer.keyInput.on('keypress', async (key) => {
        if (key.name === 'r' || key.name === 'R') { void resolveAll(); return; }
        if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
          renderer.destroy(); resolve('back');
        }
      });
    });
  }

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, { content: '[B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy(); resolve('back');
      }
    });
  });
}
