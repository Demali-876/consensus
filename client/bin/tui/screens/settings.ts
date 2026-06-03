/**
 * Settings screen - wallet balances and editable user defaults.
 */
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import { C } from '../../theme';
import { loadConfig } from '../../lib/config.ts';
import { loadPrefs, savePrefs, type Preferences } from '../../lib/store.ts';
import { privateKeyToAccount } from 'viem/accounts';
import type { Chain } from 'viem';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { base58 } from '@scure/base';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

const VERSION = '2.4.1';

const EVM_NETWORKS = [
  { key: 'ethereum', label: 'Ethereum', chainId: 1,        usdc: null },
  { key: 'base',     label: 'Base',     chainId: 8453,     usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}` },
  { key: 'baseSep',  label: 'Base Sep', chainId: 84532,    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}` },
  { key: 'ethSep',   label: 'Eth Sep',  chainId: 11155111, usdc: null },
] as const;

const SVM_NETWORKS = [
  { key: 'mainnet', label: 'Mainnet', rpc: 'https://api.mainnet-beta.solana.com', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { key: 'devnet',  label: 'Devnet',  rpc: 'https://api.devnet.solana.com',       usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
] as const;

const ICP_CANISTERS = [
  { id: 'ryjl3-tyaaa-aaaaa-aaaba-cai', symbol: 'ICP' },
  { id: 'xevnm-gaaaa-aaaar-qafnq-cai', symbol: 'ckETH' },
  { id: 'cngnf-vqaaa-aaaar-qag4q-cai', symbol: 'ckUSDC' },
  { id: '3jkp5-oyaaa-aaaaj-azwqa-cai', symbol: 'ckUSDT' },
  { id: 'xafvr-biaaa-aaaai-aql5q-cai', symbol: 'TESTICP' },
] as const;

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

type Tab = 'wallet' | 'prefs';
type FieldKind = 'text' | 'toggle';
type PrefFieldId =
  | 'displayName' | 'theme'
  | 'defaultProxyPort' | 'defaultCacheTtl' | 'defaultBudget' | 'defaultVerbose'
  | 'defaultRegion' | 'defaultNetwork' | 'defaultExcludeNode'
  | 'defaultProtocol' | 'defaultTarget'
  | 'defaultWsModel' | 'defaultWsMinutes' | 'defaultWsMegabytes';

type PrefField = {
  id: PrefFieldId;
  label: string;
  kind: FieldKind;
  value: string;
  options?: string[];
  hint: string;
  refs?: FieldRefs;
  section: 'identity' | 'proxy' | 'tunnel' | 'websocket';
};

type FieldRefs = {
  row: BoxRenderable;
  label: TextRenderable;
  inputBox: BoxRenderable;
  value: TextRenderable;
  suffix?: TextRenderable;
};

type WalletRefs = {
  walletName: TextRenderable;
  walletType: TextRenderable;
  setupDate: TextRenderable;
  leasedNode: TextRenderable;
  evmAddr: TextRenderable;
  evmNative: Record<string, TextRenderable>;
  evmUsdc: Record<string, TextRenderable>;
  svmAddr: TextRenderable;
  svmNative: Record<string, TextRenderable>;
  svmUsdc: Record<string, TextRenderable>;
  icpPrincipal: TextRenderable;
  icpBalances: Record<string, TextRenderable>;
  spendable: TextRenderable;
  proxyUrl: TextRenderable;
};

function terminalColumns(): number {
  return Math.max(96, process.stdout.columns || 168);
}

function labelText(text: string): string {
  return text.toUpperCase();
}

function shortMiddle(value: string | undefined, front = 6, back = 4): string {
  if (!value) return '—';
  if (value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

function acctLabel(): string {
  const prefs = loadPrefs();
  const cfg = loadConfig();
  return prefs.displayName
    || cfg.wallet_name
    || shortMiddle(cfg.addresses?.evm)
    || 'guest';
}

function setupDateLabel(raw?: string): string {
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '');
}

function makeBadge(
  renderer: CliRenderer,
  text: string,
  opts: { bg?: string; fg?: string } = {},
): BoxRenderable {
  const bg = opts.bg ?? C.slate;
  const box = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: bg });
  box.add(new TextRenderable(renderer, {
    content: text,
    fg: opts.fg ?? C.dark,
    bg,
    attributes: TextAttributes.BOLD,
  }));
  return box;
}

function makeTopBar(renderer: CliRenderer, root: RootRenderable): void {
  const topBar = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingX: 2,
    paddingY: 0,
    border: ['bottom'],
    borderColor: C.line2,
    backgroundColor: C.dark,
  });

  const brand = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.dark });
  brand.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS',
    fg: C.white,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  brand.add(new TextRenderable(renderer, {
    content: 'your private network, on demand',
    fg: C.dim,
    bg: C.dark,
  }));

  const status = new BoxRenderable(renderer, { flexDirection: 'row', gap: 3, backgroundColor: C.dark });
  status.add(new TextRenderable(renderer, {
    content: '● connected',
    fg: C.emerald,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `acct ${acctLabel()}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `bal $${Number(process.env.CONSENSUS_BALANCE_USD ?? 24.18).toFixed(2)}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  status.add(new TextRenderable(renderer, {
    content: `v ${VERSION}`,
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));

  topBar.add(brand);
  topBar.add(status);
  root.add(topBar);
}

function makeTabs(renderer: CliRenderer, initial: Tab): {
  row: BoxRenderable;
  setActive(tab: Tab): void;
} {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.dark,
  });
  const walletBox = new BoxRenderable(renderer, {
    width: 15,
    flexDirection: 'row',
    justifyContent: 'center',
    border: true,
    borderStyle: 'rounded',
    borderColor: initial === 'wallet' ? C.accent : C.line2,
    backgroundColor: initial === 'wallet' ? C.accent : C.dark,
  });
  const walletText = new TextRenderable(renderer, {
    content: 'W WALLET',
    fg: initial === 'wallet' ? C.dark : C.slate,
    bg: initial === 'wallet' ? C.accent : C.dark,
    attributes: TextAttributes.BOLD,
  });
  walletBox.add(walletText);

  const prefBox = new BoxRenderable(renderer, {
    width: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    border: true,
    borderStyle: 'rounded',
    borderColor: initial === 'prefs' ? C.accent : C.line2,
    backgroundColor: initial === 'prefs' ? C.accent : C.dark,
  });
  const prefText = new TextRenderable(renderer, {
    content: 'P PREFERENCES',
    fg: initial === 'prefs' ? C.dark : C.slate,
    bg: initial === 'prefs' ? C.accent : C.dark,
    attributes: TextAttributes.BOLD,
  });
  prefBox.add(prefText);

  row.add(walletBox);
  row.add(prefBox);

  return {
    row,
    setActive(tab: Tab) {
      const walletOn = tab === 'wallet';
      walletBox.backgroundColor = walletOn ? C.accent : C.dark;
      walletBox.borderColor = walletOn ? C.accent : C.line2;
      walletText.bg = walletOn ? C.accent : C.dark;
      walletText.fg = walletOn ? C.dark : C.slate;
      prefBox.backgroundColor = walletOn ? C.dark : C.accent;
      prefBox.borderColor = walletOn ? C.line2 : C.accent;
      prefText.bg = walletOn ? C.dark : C.accent;
      prefText.fg = walletOn ? C.slate : C.dark;
    },
  };
}

function makeHeader(
  renderer: CliRenderer,
  title: string,
  subtitle: string,
  tab: Tab,
): { box: BoxRenderable; tabs: ReturnType<typeof makeTabs> } {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  const left = new BoxRenderable(renderer, { flexDirection: 'column', backgroundColor: C.dark });
  left.add(new TextRenderable(renderer, {
    content: title,
    fg: C.white,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  left.add(new TextRenderable(renderer, {
    content: subtitle,
    fg: C.dim,
    bg: C.dark,
  }));
  const tabs = makeTabs(renderer, tab);
  box.add(left);
  box.add(tabs.row);
  return { box, tabs };
}

function makeInfoCard(renderer: CliRenderer, title: string, opts: { width?: number; chip?: boolean } = {}): {
  box: BoxRenderable;
  value: TextRenderable;
} {
  const box = new BoxRenderable(renderer, {
    width: opts.width,
    flexGrow: opts.width ? 0 : 1,
    height: 5,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 0,
    border: true,
    borderStyle: 'rounded',
    borderColor: C.line2,
    backgroundColor: C.dark,
  });
  box.add(new TextRenderable(renderer, {
    content: labelText(title),
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const value = new TextRenderable(renderer, {
    content: '—',
    height: 1,
    fg: opts.chip ? C.emerald : C.white,
    bg: opts.chip ? C.panel : C.dark,
    attributes: TextAttributes.BOLD,
  });
  if (opts.chip) {
    const chipRow = new BoxRenderable(renderer, {
      flexDirection: 'row',
      backgroundColor: C.dark,
    });
    const chip = new BoxRenderable(renderer, {
      flexDirection: 'row',
      paddingX: 1,
      backgroundColor: C.panel,
    });
    chip.add(value);
    chipRow.add(chip);
    box.add(chipRow);
  } else {
    box.add(value);
  }
  return { box, value };
}

function makeWalletPanel(
  renderer: CliRenderer,
  title: string,
  glyph: string,
  glyphColor: string,
  height: number,
  width: number | '100%' = '100%',
): { box: BoxRenderable; body: BoxRenderable } {
  // opentui paints the panel title in the border color, so we color the border
  // the same shade as the glyph to keep the title legible against the title
  // hue in the mock (EVM=emerald, Solana=accent, ICP=amber).
  const box = new BoxRenderable(renderer, {
    width,
    height,
    flexDirection: 'column',
    border: true,
    borderStyle: 'rounded',
    borderColor: glyphColor,
    title: ` ${glyph} ${title} `,
    paddingX: 1,
    paddingY: 1,
    backgroundColor: C.dark,
  });
  const body = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'column',
    backgroundColor: C.dark,
  });
  box.add(body);
  return { box, body };
}

function makeTableHeader(renderer: CliRenderer, columns: Array<{ label: string; width: number }>): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 2,
    border: ['top'],
    borderColor: C.line2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  for (const col of columns) {
    row.add(new TextRenderable(renderer, {
      content: labelText(col.label).padEnd(col.width),
      height: 1,
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
  }
  return row;
}

function makeTableRow(
  renderer: CliRenderer,
  cells: Array<{ text: string; width: number; fg?: string }>,
): { row: BoxRenderable; values: TextRenderable[] } {
  const row = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.dark });
  const values: TextRenderable[] = [];
  for (const cell of cells) {
    const text = new TextRenderable(renderer, {
      content: cell.text.padEnd(cell.width),
      height: 1,
      fg: cell.fg ?? C.slate,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    row.add(text);
    values.push(text);
  }
  return { row, values };
}

/**
 * Row of the form `● LABEL  <value>` where the bullet, label, and value each
 * carry their own color (matching the panel hue, dim, and slate respectively
 * in the mock).
 */
function makeAddrRow(
  renderer: CliRenderer,
  bulletColor: string,
  label: string,
  value: string,
): { row: BoxRenderable; valueRef: TextRenderable } {
  const row = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
  row.add(new TextRenderable(renderer, {
    content: '●', height: 1, fg: bulletColor, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  row.add(new TextRenderable(renderer, {
    content: label, height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  const valueRef = new TextRenderable(renderer, {
    content: value, height: 1, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  row.add(valueRef);
  return { row, valueRef };
}

function parseAmount(text: string): number {
  const n = Number.parseFloat(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function makeFooter(renderer: CliRenderer, tab: Tab): { box: BoxRenderable; right: TextRenderable; setTab(tab: Tab): void } {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingX: 2,
    paddingY: 0,
    border: ['top'],
    borderColor: C.line2,
    backgroundColor: C.panel,
  });
  const chips = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.panel });
  const hints = [
    { key: 'W', label: 'wallet' },
    { key: 'P', label: 'preferences' },
    { key: 'R', label: 'refresh' },
    { key: '↑↓', label: 'navigate ·' },
    { key: '↵←→', label: 'edit' },
    { key: 'B', label: 'back' },
  ];
  for (const hint of hints) {
    const pair = new BoxRenderable(renderer, {
      flexDirection: 'row',
      gap: 1,
      alignItems: 'center',
      backgroundColor: C.panel,
    });
    pair.add(makeBadge(renderer, hint.key));
    pair.add(new TextRenderable(renderer, { content: hint.label, fg: C.slate, bg: C.panel }));
    chips.add(pair);
  }
  const right = new TextRenderable(renderer, {
    content: tab === 'wallet' ? 'SETTINGS · WALLET' : 'SETTINGS · PREFS',
    fg: C.dim,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  box.add(chips);
  box.add(right);
  return {
    box,
    right,
    setTab(next: Tab) {
      right.content = next === 'wallet' ? 'SETTINGS · WALLET' : 'SETTINGS · PREFS';
    },
  };
}

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

async function resolveEvmEthBalance(address: `0x${string}`, chainId: number): Promise<string> {
  try {
    const { formatEther } = await import('viem');
    const client = await getEvmClient(chainId);
    const bal = await client.getBalance({ address });
    return `${parseFloat(formatEther(bal)).toFixed(6)} ETH`;
  } catch {
    return '—';
  }
}

async function resolveEvmUsdcBalance(
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

async function resolveSvmAddress(privateKey: string): Promise<string> {
  try {
    const signer = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    return signer.address;
  } catch {
    return '(invalid key)';
  }
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
  } catch {
    return '—';
  }
}

async function resolveSvmUsdcBalance(address: string, rpcUrl: string, usdcMint: string): Promise<string> {
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

async function resolveIcpPrincipal(pemPath: string): Promise<string> {
  try {
    const pem = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
    const { Secp256k1KeyIdentity } = await import('@dfinity/identity-secp256k1');
    return Secp256k1KeyIdentity.fromPem(pem).getPrincipal().toText();
  } catch {
    return '(invalid PEM)';
  }
}

async function resolveIcpCanisterBalance(
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

function makeWalletPane(renderer: CliRenderer): { pane: BoxRenderable; refs: WalletRefs } {
  const cfg = loadConfig();
  const lease = cfg.leased_node;
  const cols = terminalColumns();
  const contentWidth = Math.max(88, cols - 4);
  const gap = 2;
  const cardWidth = Math.max(20, Math.floor((contentWidth - gap * 3) / 4));
  const walletPanelWidth = Math.max(44, Math.floor((contentWidth - gap) / 2));
  const tableCols = cols >= 140
    ? { network: 22, native: 22, usdc: 18 }
    : { network: 16, native: 18, usdc: 13 };
  const pane = new BoxRenderable(renderer, {
    id: 'settings-wallet-pane',
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });

  const cardRow = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 2,
    backgroundColor: C.dark,
  });
  const walletName = makeInfoCard(renderer, 'Wallet name', { width: cardWidth });
  const walletType = makeInfoCard(renderer, 'Type', { width: cardWidth, chip: true });
  const setupDate = makeInfoCard(renderer, 'Setup date', { width: cardWidth });
  const leasedNode = makeInfoCard(renderer, 'Leased node', { width: cardWidth });
  cardRow.add(walletName.box);
  cardRow.add(walletType.box);
  cardRow.add(setupDate.box);
  cardRow.add(leasedNode.box);
  pane.add(cardRow);

  const row = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });

  const evm = makeWalletPanel(renderer, 'EVM', '◇', C.emerald, 13, walletPanelWidth);
  const solana = makeWalletPanel(renderer, 'SOLANA', '⊙', C.accent, 13, walletPanelWidth);
  row.add(evm.box);
  row.add(solana.box);
  pane.add(row);

  const evmAddrRow = makeAddrRow(renderer, C.emerald, 'ADDR', shortMiddle(cfg.addresses?.evm, 8, 4));
  evm.body.add(evmAddrRow.row);
  evm.body.add(makeTableHeader(renderer, [
    { label: 'Network', width: tableCols.network },
    { label: 'Native', width: tableCols.native },
    { label: 'USDC', width: tableCols.usdc },
  ]));
  const evmNative: Record<string, TextRenderable> = {};
  const evmUsdc: Record<string, TextRenderable> = {};
  for (const n of EVM_NETWORKS) {
    const tableRow = makeTableRow(renderer, [
      { text: n.label, width: tableCols.network },
      { text: '—', width: tableCols.native, fg: C.dim },
      { text: '—', width: tableCols.usdc, fg: C.dim },
    ]);
    evm.body.add(tableRow.row);
    evmNative[n.key] = tableRow.values[1]!;
    evmUsdc[n.key] = tableRow.values[2]!;
  }

  const svmAddrRow = makeAddrRow(renderer, C.accent, 'ADDR', shortMiddle(cfg.addresses?.solana, 8, 4));
  solana.body.add(svmAddrRow.row);
  solana.body.add(makeTableHeader(renderer, [
    { label: 'Network', width: tableCols.network },
    { label: 'Native', width: tableCols.native },
    { label: 'USDC', width: tableCols.usdc },
  ]));
  const svmNative: Record<string, TextRenderable> = {};
  const svmUsdc: Record<string, TextRenderable> = {};
  for (const n of SVM_NETWORKS) {
    const tableRow = makeTableRow(renderer, [
      { text: n.label, width: tableCols.network },
      { text: '—', width: tableCols.native, fg: C.dim },
      { text: '—', width: tableCols.usdc, fg: C.dim },
    ]);
    solana.body.add(tableRow.row);
    svmNative[n.key] = tableRow.values[1]!;
    svmUsdc[n.key] = tableRow.values[2]!;
  }

  const icp = makeWalletPanel(renderer, 'ICP · principal', '∞', C.amber, 7);
  const principalRow = makeAddrRow(renderer, C.amber, 'PRINCIPAL', shortMiddle(cfg.addresses?.icp, 20, 10));
  icp.body.add(principalRow.row);
  const icpGrid = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    border: ['top'],
    borderColor: C.line2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });
  const icpBalances: Record<string, TextRenderable> = {};
  for (const item of ICP_CANISTERS) {
    const group = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
    group.add(new TextRenderable(renderer, {
      content: item.symbol,
      fg: C.slate,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    const value = new TextRenderable(renderer, {
      content: '—',
      fg: C.emerald,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    group.add(value);
    icpGrid.add(group);
    icpBalances[item.symbol] = value;
  }
  icp.body.add(icpGrid);
  pane.add(icp.box);

  const summary = new BoxRenderable(renderer, {
    width: '100%',
    height: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 1,
    paddingX: 2,
    border: true,
    borderStyle: 'rounded',
    borderColor: C.emerald,
    backgroundColor: C.dark,
  });
  const spendGroup = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.dark });
  spendGroup.add(new TextRenderable(renderer, {
    content: 'SPENDABLE USDC · ALL CHAINS',
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const spendable = new TextRenderable(renderer, {
    content: '$0.00',
    fg: C.emerald,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  spendGroup.add(spendable);
  const proxyGroup = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, backgroundColor: C.dark });
  proxyGroup.add(new TextRenderable(renderer, {
    content: 'proxy url ·',
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const proxyUrl = new TextRenderable(renderer, {
    content: cfg.x402_proxy_url ?? 'x402.consensus.network',
    fg: C.slate,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  proxyGroup.add(proxyUrl);
  proxyGroup.add(new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark }));
  proxyGroup.add(makeBadge(renderer, 'R'));
  proxyGroup.add(new TextRenderable(renderer, { content: 'refresh', fg: C.slate, bg: C.dark }));
  summary.add(spendGroup);
  summary.add(proxyGroup);
  pane.add(summary);

  walletName.value.content = cfg.wallet_name ?? '—';
  walletType.value.content = cfg.wallet_type ?? (cfg.api_key ? 'cdp-managed' : 'self-managed');
  setupDate.value.content = setupDateLabel(cfg.setup_date);
  leasedNode.value.content = lease
    ? `${lease.domain}${lease.region ? ` · ${lease.region}` : ''}`
    : 'none';
  walletType.value.fg = C.emerald;
  leasedNode.value.fg = lease ? C.emerald : C.dim;

  return {
    pane,
    refs: {
      walletName: walletName.value,
      walletType: walletType.value,
      setupDate: setupDate.value,
      leasedNode: leasedNode.value,
      evmAddr: evmAddrRow.valueRef,
      evmNative,
      evmUsdc,
      svmAddr: svmAddrRow.valueRef,
      svmNative,
      svmUsdc,
      icpPrincipal: principalRow.valueRef,
      icpBalances,
      spendable,
      proxyUrl,
    },
  };
}

function networkPrefToOption(caip2: string | undefined): string {
  if (!caip2) return 'Base';
  if (caip2.startsWith('solana:')) return 'Solana';
  return 'Base';
}

function networkOptionToPref(option: string): string {
  return option === 'Solana'
    ? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    : 'eip155:8453';
}

function makeInputField(
  renderer: CliRenderer,
  parent: BoxRenderable,
  label: string,
  field: PrefField,
  opts: { width?: number; suffix?: string; labelWidth?: number } = {},
): FieldRefs {
  const row = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    backgroundColor: C.dark,
  });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(opts.labelWidth ?? 15),
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const inputBox = new BoxRenderable(renderer, {
    width: opts.width ?? 22,
    flexDirection: 'row',
    paddingX: 1,
    border: true,
    borderStyle: 'rounded',
    borderColor: C.line2,
    backgroundColor: C.panel,
  });
  const value = new TextRenderable(renderer, {
    content: field.value || ' ',
    height: 1,
    fg: field.value ? C.slate : C.dim,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  inputBox.add(value);
  row.add(labelRef);
  row.add(inputBox);
  let suffixRef: TextRenderable | undefined;
  if (opts.suffix) {
    suffixRef = new TextRenderable(renderer, {
      content: opts.suffix,
      height: 1,
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    row.add(suffixRef);
  }
  parent.add(row);
  return { row, label: labelRef, inputBox, value, suffix: suffixRef };
}

function makeToggleField(
  renderer: CliRenderer,
  parent: BoxRenderable,
  label: string,
  field: PrefField,
  opts: { suffix?: string; labelWidth?: number } = {},
): FieldRefs {
  const row = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    backgroundColor: C.dark,
  });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(opts.labelWidth ?? 15),
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const inputBox = new BoxRenderable(renderer, {
    flexDirection: 'row',
    gap: 1,
    alignItems: 'center',
    backgroundColor: C.dark,
  });
  const value = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  inputBox.add(value);
  row.add(labelRef);
  row.add(inputBox);
  let suffixRef: TextRenderable | undefined;
  if (opts.suffix) {
    suffixRef = new TextRenderable(renderer, {
      content: opts.suffix,
      height: 1,
      fg: C.dim,
      bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    row.add(suffixRef);
  }
  parent.add(row);
  return { row, label: labelRef, inputBox, value, suffix: suffixRef };
}

function makeSectionHeader(
  renderer: CliRenderer,
  parent: BoxRenderable,
  title: string,
  innerWidth: number,
): void {
  const row = new BoxRenderable(renderer, {
    width: '100%',
    height: 1,
    flexDirection: 'row',
    gap: 1,
    backgroundColor: C.dark,
  });
  row.add(new TextRenderable(renderer, {
    content: labelText(title),
    height: 1,
    fg: C.dim,
    bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));
  const dashes = Math.max(8, innerWidth - title.length - 2);
  row.add(new TextRenderable(renderer, {
    content: '─'.repeat(dashes),
    height: 1,
    fg: C.line2,
    bg: C.dark,
  }));
  parent.add(row);
}

function makePrefPair(
  renderer: CliRenderer,
  parent: BoxRenderable,
  leftWidth: number,
  rightWidth: number,
): { left: BoxRenderable; right: BoxRenderable } {
  const row = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    backgroundColor: C.dark,
  });
  const left = new BoxRenderable(renderer, {
    width: leftWidth,
    flexDirection: 'column',
    backgroundColor: C.dark,
  });
  const right = new BoxRenderable(renderer, {
    width: rightWidth,
    flexDirection: 'column',
    backgroundColor: C.dark,
  });
  row.add(left);
  row.add(right);
  parent.add(row);
  return { left, right };
}

function makePrefsPane(renderer: CliRenderer, fields: PrefField[]): {
  pane: BoxRenderable;
  hint: TextRenderable;
} {
  const cols = terminalColumns();
  const contentWidth = Math.max(88, cols - 8);
  const panelInner = contentWidth - 4;
  const leftWidth = Math.max(42, Math.floor((panelInner - 4) / 2));
  const rightWidth = Math.max(42, panelInner - leftWidth - 4);
  const pane = new BoxRenderable(renderer, {
    id: 'settings-prefs-pane',
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: C.dark,
  });

  const panel = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    title: ' DEFAULTS ',
    backgroundColor: C.dark,
  });

  const byId = Object.fromEntries(fields.map((f) => [f.id, f])) as Record<PrefFieldId, PrefField>;

  makeSectionHeader(renderer, panel, 'Identity', panelInner);
  let pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.displayName.refs = makeInputField(renderer, pair.left, 'Display name', byId.displayName, { width: 24 });
  byId.theme.refs = makeToggleField(renderer, pair.right, 'Theme', byId.theme);

  makeSectionHeader(renderer, panel, 'Proxy defaults', panelInner);
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultProxyPort.refs = makeInputField(renderer, pair.left, 'Proxy port', byId.defaultProxyPort, { width: 13 });
  byId.defaultCacheTtl.refs = makeInputField(renderer, pair.right, 'Cache TTL', byId.defaultCacheTtl, { width: 13, suffix: 'sec' });
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultBudget.refs = makeInputField(renderer, pair.left, 'Spend limit', byId.defaultBudget, { width: 13, suffix: 'USD / session' });
  byId.defaultVerbose.refs = makeToggleField(renderer, pair.right, 'Verbose', byId.defaultVerbose);
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultRegion.refs = makeInputField(renderer, pair.left, 'Region', byId.defaultRegion, { width: 22, suffix: 'blank = auto' });
  byId.defaultNetwork.refs = makeToggleField(renderer, pair.right, 'Network', byId.defaultNetwork, { suffix: 'USDC' });
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultExcludeNode.refs = makeInputField(renderer, pair.left, 'Exclude node', byId.defaultExcludeNode, { width: 34 });

  makeSectionHeader(renderer, panel, 'Tunnel defaults', panelInner);
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultProtocol.refs = makeToggleField(renderer, pair.left, 'Tunnel proto', byId.defaultProtocol);
  byId.defaultTarget.refs = makeInputField(renderer, pair.right, 'Tunnel target', byId.defaultTarget, { width: 22 });

  makeSectionHeader(renderer, panel, 'Websocket defaults', panelInner);
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultWsModel.refs = makeToggleField(renderer, pair.left, 'WS model', byId.defaultWsModel);
  byId.defaultWsMinutes.refs = makeInputField(renderer, pair.right, 'WS duration', byId.defaultWsMinutes, { width: 13, suffix: 'min' });
  pair = makePrefPair(renderer, panel, leftWidth, rightWidth);
  byId.defaultWsMegabytes.refs = makeInputField(renderer, pair.left, 'WS data', byId.defaultWsMegabytes, { width: 13, suffix: 'MB' });

  pane.add(panel);

  const hintBox = new BoxRenderable(renderer, {
    width: '100%',
    height: 3,
    flexDirection: 'row',
    paddingX: 2,
    marginTop: 1,
    border: true,
    borderStyle: 'single',
    borderColor: C.line2,
    backgroundColor: C.panel,
  });
  const hint = new TextRenderable(renderer, {
    content: '',
    fg: C.slate,
    bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  hintBox.add(hint);
  pane.add(hintBox);
  return { pane, hint };
}

function prefFieldsFromPrefs(prefs: Preferences): PrefField[] {
  return [
    { id: 'displayName', value: prefs.displayName, kind: 'text', label: 'Display name', hint: 'Display name · shown in the top-bar acct chip and the landing welcome message', section: 'identity' },
    { id: 'theme', value: prefs.theme, kind: 'toggle', options: ['auto', 'dark', 'light'], label: 'Theme', hint: 'Theme · auto follows system appearance; restart to fully apply theme changes', section: 'identity' },
    { id: 'defaultProxyPort', value: String(prefs.defaultProxyPort), kind: 'text', label: 'Proxy port', hint: 'Proxy port · default local proxy listen port', section: 'proxy' },
    { id: 'defaultCacheTtl', value: String(prefs.defaultCacheTtl || 300), kind: 'text', label: 'Cache TTL', hint: 'Cache TTL · seconds, 0 disables caching', section: 'proxy' },
    { id: 'defaultBudget', value: prefs.defaultBudget != null ? String(prefs.defaultBudget) : '5.00', kind: 'text', label: 'Spend limit', hint: 'Spend limit · USD cap per paid proxy session', section: 'proxy' },
    { id: 'defaultVerbose', value: prefs.defaultVerbose ? 'on' : 'off', kind: 'toggle', options: ['off', 'on'], label: 'Verbose', hint: 'Verbose · add Consensus metadata headers by default', section: 'proxy' },
    { id: 'defaultRegion', value: prefs.defaultRegion ?? 'us-west-1', kind: 'text', label: 'Region', hint: 'Region · blank means automatic node selection', section: 'proxy' },
    { id: 'defaultNetwork', value: networkPrefToOption(prefs.defaultNetwork), kind: 'toggle', options: ['Base', 'Solana'], label: 'Network', hint: 'Network · default payment network family for USDC', section: 'proxy' },
    { id: 'defaultExcludeNode', value: prefs.defaultExcludeNode ?? '', kind: 'text', label: 'Exclude node', hint: 'Exclude node · node domain to skip by default', section: 'proxy' },
    { id: 'defaultProtocol', value: prefs.defaultProtocol, kind: 'toggle', options: ['http', 'tcp'], label: 'Tunnel proto', hint: 'Tunnel proto · default tunnel protocol', section: 'tunnel' },
    { id: 'defaultTarget', value: prefs.defaultTarget ?? 'localhost', kind: 'text', label: 'Tunnel target', hint: 'Tunnel target · pre-fill target field in new tunnels', section: 'tunnel' },
    { id: 'defaultWsModel', value: prefs.defaultWsModel, kind: 'toggle', options: ['hybrid', 'time', 'data'], label: 'WS model', hint: 'WS model · default WebSocket billing model', section: 'websocket' },
    { id: 'defaultWsMinutes', value: String(prefs.defaultWsMinutes || 60), kind: 'text', label: 'WS duration', hint: 'WS duration · default WebSocket session minutes', section: 'websocket' },
    { id: 'defaultWsMegabytes', value: String(prefs.defaultWsMegabytes || 500), kind: 'text', label: 'WS data', hint: 'WS data · default WebSocket data allowance in MB', section: 'websocket' },
  ];
}

function persistField(field: PrefField): void {
  const raw = field.value.trim();
  switch (field.id) {
    case 'defaultProxyPort':
    case 'defaultCacheTtl':
    case 'defaultWsMinutes':
    case 'defaultWsMegabytes': {
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n)) savePrefs({ [field.id]: n });
      break;
    }
    case 'defaultBudget': {
      const n = Number.parseFloat(raw);
      savePrefs({ defaultBudget: Number.isNaN(n) || raw === '' ? undefined : n });
      break;
    }
    case 'defaultVerbose':
      savePrefs({ defaultVerbose: raw === 'on' });
      break;
    case 'defaultProtocol':
      savePrefs({ defaultProtocol: raw === 'tcp' ? 'tcp' : 'http' });
      break;
    case 'defaultWsModel':
      savePrefs({ defaultWsModel: raw === 'time' || raw === 'data' ? raw : 'hybrid' });
      break;
    case 'theme':
      savePrefs({ theme: raw === 'dark' || raw === 'light' ? raw : 'auto' });
      break;
    case 'defaultNetwork':
      savePrefs({ defaultNetwork: networkOptionToPref(raw) });
      break;
    case 'displayName':
    case 'defaultRegion':
    case 'defaultExcludeNode':
    case 'defaultTarget':
      savePrefs({ [field.id]: raw || undefined });
      break;
  }
}

function renderToggle(renderer: CliRenderer, field: PrefField, focused: boolean): void {
  const refs = field.refs;
  if (!refs) return;
  while (refs.inputBox.getChildrenCount() > 0) {
    const child = refs.inputBox.getChildren()[0];
    if (!child) break;
    refs.inputBox.remove(child.id);
  }
  for (const opt of field.options ?? []) {
    const active = field.value === opt;
    const bg = active ? (focused ? C.accent : C.emerald) : C.line2;
    const chip = new BoxRenderable(renderer, {
      flexDirection: 'row',
      paddingX: 1,
      backgroundColor: bg,
    });
    chip.add(new TextRenderable(renderer, {
      content: opt,
      height: 1,
      fg: active ? C.dark : C.slate,
      bg,
      attributes: TextAttributes.BOLD,
    }));
    refs.inputBox.add(chip);
  }
}

function renderPrefFields(renderer: CliRenderer, fields: PrefField[], cursor: number, editBuf: string | null, hint: TextRenderable): void {
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const refs = field.refs;
    if (!refs) continue;
    const focused = i === cursor;
    refs.label.fg = focused ? C.white : C.dim;
    if (field.kind === 'toggle') {
      renderToggle(renderer, field, focused);
    } else {
      refs.inputBox.borderColor = focused ? C.accent : C.line2;
      const raw = editBuf !== null && focused ? `${editBuf}█` : field.value;
      refs.value.content = raw || ' ';
      refs.value.fg = raw ? C.white : C.dim;
    }
  }
  hint.content = fields[cursor]?.hint ?? '';
}

async function refreshWallet(refs: WalletRefs, live: () => boolean): Promise<void> {
  const cfg = loadConfig();
  const evmKey = process.env.CONSENSUS_EVM_KEY;
  const svmKey = process.env.CONSENSUS_SVM_KEY;
  const pemPath = process.env.CONSENSUS_PEM_PATH;

  let spendable = 0;
  const setVal = (ref: TextRenderable, value: string, fg = C.slate): void => {
    if (!live()) return;
    ref.content = value;
    ref.fg = fg;
  };
  // Active monetary values render emerald; placeholders/zero stay dim.
  const setBal = (ref: TextRenderable, value: string): void => {
    setVal(ref, value, value === '—' ? C.dim : C.emerald);
  };
  const setMoney = (ref: TextRenderable, value: string): void => {
    setBal(ref, value);
    if (value.includes('USDC')) spendable += parseAmount(value);
    refs.spendable.content = `$${spendable.toFixed(2)}`;
  };

  refs.evmAddr.content = evmKey ? 'resolving…' : shortMiddle(cfg.addresses?.evm, 8, 4);
  refs.svmAddr.content = svmKey ? 'resolving…' : shortMiddle(cfg.addresses?.solana, 8, 4);
  refs.icpPrincipal.content = pemPath ? 'resolving…' : shortMiddle(cfg.addresses?.icp, 20, 10);
  for (const ref of Object.values(refs.evmNative)) setVal(ref, 'querying…', C.dim);
  for (const ref of Object.values(refs.evmUsdc)) setVal(ref, 'querying…', C.dim);
  for (const ref of Object.values(refs.svmNative)) setVal(ref, 'querying…', C.dim);
  for (const ref of Object.values(refs.svmUsdc)) setVal(ref, 'querying…', C.dim);
  for (const ref of Object.values(refs.icpBalances)) setVal(ref, 'querying…', C.dim);
  refs.spendable.content = '$0.00';

  if (evmKey) {
    const addr = await resolveEvmAddress(evmKey);
    setVal(refs.evmAddr, addr === '(invalid key)' ? addr : shortMiddle(addr, 8, 4), addr === '(invalid key)' ? C.red : C.emerald);
    if (addr !== '(invalid key)') {
      for (const n of EVM_NETWORKS) {
        void resolveEvmEthBalance(addr, n.chainId).then((value) => setBal(refs.evmNative[n.key]!, value));
        if (n.usdc) {
          void resolveEvmUsdcBalance(addr, n.chainId, n.usdc).then((value) => setMoney(refs.evmUsdc[n.key]!, value));
        } else {
          setVal(refs.evmUsdc[n.key]!, '—', C.dim);
        }
      }
    }
  } else {
    for (const n of EVM_NETWORKS) {
      setVal(refs.evmNative[n.key]!, '—', C.dim);
      setVal(refs.evmUsdc[n.key]!, '—', C.dim);
    }
  }

  if (svmKey) {
    const addr = await resolveSvmAddress(svmKey);
    setVal(refs.svmAddr, addr === '(invalid key)' ? addr : shortMiddle(addr, 8, 4), addr === '(invalid key)' ? C.red : C.emerald);
    if (addr !== '(invalid key)') {
      for (const n of SVM_NETWORKS) {
        void resolveSvmSolBalance(addr, n.rpc).then((value) => setBal(refs.svmNative[n.key]!, value));
        void resolveSvmUsdcBalance(addr, n.rpc, n.usdc).then((value) => setMoney(refs.svmUsdc[n.key]!, value));
      }
    }
  } else {
    for (const n of SVM_NETWORKS) {
      setVal(refs.svmNative[n.key]!, '—', C.dim);
      setVal(refs.svmUsdc[n.key]!, '—', C.dim);
    }
  }

  if (pemPath) {
    const principal = await resolveIcpPrincipal(pemPath);
    setVal(refs.icpPrincipal, principal === '(invalid PEM)' ? principal : shortMiddle(principal, 20, 10), principal === '(invalid PEM)' ? C.red : C.emerald);
    if (principal !== '(invalid PEM)') {
      try {
        const pem = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
        const { Secp256k1KeyIdentity } = await import('@dfinity/identity-secp256k1');
        const { HttpAgent, Actor } = await import('@dfinity/agent');
        const identity = Secp256k1KeyIdentity.fromPem(pem);
        const agent = HttpAgent.createSync({ host: 'https://ic0.app', identity, fetch: globalThis.fetch.bind(globalThis) });
        const owner = identity.getPrincipal();
        for (const item of ICP_CANISTERS) {
          void resolveIcpCanisterBalance(Actor, agent, owner, item.id, item.symbol).then(({ symbol, formatted }) => {
            const ref = refs.icpBalances[symbol] ?? refs.icpBalances[item.symbol];
            if (ref) setVal(ref, formatted, formatted === '—' ? C.dim : C.emerald);
          });
        }
      } catch {
        for (const ref of Object.values(refs.icpBalances)) setVal(ref, '—', C.dim);
      }
    }
  } else {
    for (const ref of Object.values(refs.icpBalances)) setVal(ref, '—', C.dim);
  }
}

export async function showSettings(): Promise<'back'> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 15,
    useMouse: false,
    useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  let activeTab: Tab = 'wallet';
  makeTopBar(renderer, root);

  const shell = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    backgroundColor: C.dark,
  });
  root.add(shell);

  const walletHeader = makeHeader(
    renderer,
    'Settings / Wallet',
    'self-managed — your keys never leave this machine',
    'wallet',
  );
  const prefsHeader = makeHeader(
    renderer,
    'Settings / Preferences',
    'defaults applied to new tunnels, proxies & sockets — saved instantly',
    'prefs',
  );
  const wallet = makeWalletPane(renderer);
  const fields = prefFieldsFromPrefs(loadPrefs());
  const prefs = makePrefsPane(renderer, fields);

  shell.add(walletHeader.box);
  shell.add(wallet.pane);

  const footer = makeFooter(renderer, activeTab);
  root.add(footer.box);

  let live = true;
  let cursor = 0;
  let editBuf: string | null = null;

  const switchTab = (tab: Tab): void => {
    if (activeTab === tab) return;
    activeTab = tab;
    editBuf = null;
    while (shell.getChildrenCount() > 0) {
      const child = shell.getChildren()[0];
      if (!child) break;
      shell.remove(child.id);
    }
    if (tab === 'wallet') {
      shell.add(walletHeader.box);
      shell.add(wallet.pane);
    } else {
      shell.add(prefsHeader.box);
      shell.add(prefs.pane);
      renderPrefFields(renderer, fields, cursor, editBuf, prefs.hint);
    }
    walletHeader.tabs.setActive(tab);
    prefsHeader.tabs.setActive(tab);
    footer.setTab(tab);
  };

  void refreshWallet(wallet.refs, () => live);

  return new Promise<'back'>((resolve) => {
    const done = (): void => {
      live = false;
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!live) return;

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        done();
        return;
      }
      if ((key.name === 'w' || key.name === 'W')) {
        switchTab('wallet');
        return;
      }
      if ((key.name === 'p' || key.name === 'P')) {
        switchTab('prefs');
        return;
      }
      if (activeTab === 'wallet') {
        if (key.name === 'r' || key.name === 'R') void refreshWallet(wallet.refs, () => live);
        return;
      }

      const current = fields[cursor]!;
      if (editBuf !== null) {
        if (key.name === 'escape') {
          editBuf = null;
        } else if (key.name === 'return' || key.name === 'enter') {
          current.value = editBuf;
          editBuf = null;
          persistField(current);
        } else if (key.name === 'backspace') {
          editBuf = editBuf.slice(0, -1);
        } else if (key.sequence?.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ') {
          editBuf += key.sequence;
        }
        renderPrefFields(renderer, fields, cursor, editBuf, prefs.hint);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + fields.length) % fields.length;
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % fields.length;
      } else if (key.name === 'return' || key.name === 'enter') {
        if (current.kind === 'text') {
          editBuf = current.value;
        } else {
          const opts = current.options ?? [];
          current.value = opts[(opts.indexOf(current.value) + 1) % opts.length] ?? current.value;
          persistField(current);
        }
      } else if (key.name === 'right' && current.kind === 'toggle') {
        const opts = current.options ?? [];
        current.value = opts[(opts.indexOf(current.value) + 1) % opts.length] ?? current.value;
        persistField(current);
      } else if (key.name === 'left' && current.kind === 'toggle') {
        const opts = current.options ?? [];
        current.value = opts[(opts.indexOf(current.value) - 1 + opts.length) % opts.length] ?? current.value;
        persistField(current);
      }
      renderPrefFields(renderer, fields, cursor, editBuf, prefs.hint);
    });
  });
}
