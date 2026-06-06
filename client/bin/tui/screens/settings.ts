import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from '@opentui/core';
import { C } from '../../theme';
import { makeBadge, makeKeyBar, makeTopBar, shortMiddle, termCols, upper } from '../chrome.ts';
import {
  makePrefsPane,
  prefFieldsFromPrefs,
  persistField,
  renderPrefFields,
  type PrefField,
} from './settings-prefs.ts';
import { loadConfig } from '../../lib/config.ts';
import { loadPrefs } from '../../lib/store.ts';
import {
  resolveEvmAddress,
  resolveEvmEthBalance,
  resolveEvmUsdcBalance,
  resolveSvmAddress,
  resolveSvmSolBalance,
  resolveSvmUsdcBalance,
  resolveIcpPrincipal,
  resolveIcpCanisterBalance,
} from '../../lib/wallet-balances.ts';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

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

type Tab = 'wallet' | 'prefs';

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

function setupDateLabel(raw?: string): string {
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '');
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
    content: upper(title),
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
      content: upper(col.label).padEnd(col.width),
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

const FOOTER_HINTS = [
  { key: 'W', label: 'wallet' },
  { key: 'P', label: 'preferences' },
  { key: 'R', label: 'refresh' },
  { key: '↑↓', label: 'navigate ·' },
  { key: '↵←→', label: 'edit' },
  { key: 'B', label: 'back' },
];

function footerLabel(tab: Tab): string {
  return tab === 'wallet' ? 'SETTINGS · WALLET' : 'SETTINGS · PREFS';
}

function makeWalletPane(renderer: CliRenderer): { pane: BoxRenderable; refs: WalletRefs } {
  const cfg = loadConfig();
  const lease = cfg.leased_node;
  const cols = termCols();
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
  proxyGroup.add(makeBadge(renderer, 'R').box);
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

  const footer = makeKeyBar(renderer, FOOTER_HINTS, footerLabel(activeTab));
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
    footer.right.content = footerLabel(tab);
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
