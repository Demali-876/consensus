/**
 * Shared scaffolding for the proxy setup screens (forward + reverse).
 *
 * The two flows look identical from the outside — same top bar, breadcrumb +
 * TYPE toggle, DETECTED · LOCALHOST list, BOOKMARKS, WALLET, footer chips —
 * and differ only in the right-column form sections. This module owns the
 * shared bits; forward.ts and reverse.ts add their own form sections on top.
 */

import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../../theme';
import { loadConfig, loadPrefs, type Bookmark } from '../../../lib/store.ts';
import type { DiscoveredProcess } from '../../../lib/discover.ts';

// ─── Network families ────────────────────────────────────────────────────────
//
// The full NETWORK_OPTIONS list (in bin/lib/networks.ts) has 10 entries
// across EVM testnet/mainnet, Solana devnet/mainnet, and three ICP ledgers.
// For the UI we collapse to three FAMILIES and pick a sensible default
// subnet per family. PreferNetwork is a free-form string downstream, so we
// just thread the chosen CAIP-2 through.

export type NetworkFamily = 'evm' | 'svm' | 'icp';

export const FAMILY_LABEL: Record<NetworkFamily, string> = {
  evm: 'EVM',
  svm: 'SVM',
  icp: 'ICP',
};

/** Default CAIP-2 per family. Matches the testnets we already enumerate. */
export const FAMILY_DEFAULT_CAIP2: Record<NetworkFamily, string> = {
  evm: 'eip155:84532',                                  // Base Sepolia
  svm: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',       // Sol Devnet
  icp: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai',             // TESTICP
};

/** Per-family chain options. Each entry maps a short chip label → CAIP-2. */
export const CHAINS_BY_FAMILY: Record<NetworkFamily, Array<{ label: string; caip2: string }>> = {
  evm: [
    { label: 'BaseSep', caip2: 'eip155:84532'    },
    { label: 'Base',    caip2: 'eip155:8453'     },
    { label: 'EthSep',  caip2: 'eip155:11155111' },
    { label: 'Eth',     caip2: 'eip155:1'        },
  ],
  svm: [
    { label: 'Devnet',  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
    { label: 'Mainnet', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  ],
  icp: [
    { label: 'TESTICP', caip2: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai' },
    { label: 'ckUSDC',  caip2: 'icp:1:cngnf-vqaaa-aaaar-qag4q-cai' },
    { label: 'ckETH',   caip2: 'icp:1:xevnm-gaaaa-aaaar-qafnq-cai' },
  ],
};

export function familyFromCaip2(caip2: string | undefined): NetworkFamily {
  if (!caip2) return 'evm';
  if (caip2.startsWith('eip155:')) return 'evm';
  if (caip2.startsWith('solana:')) return 'svm';
  if (caip2.startsWith('icp:'))    return 'icp';
  return 'evm';
}

// ─── Shared badge helper (matches the landing/tunnel chip style) ────────────

export function makeBadge(
  renderer: CliRenderer,
  text: string,
  opts: { bg: string; fg?: string } = { bg: C.accent },
): { box: BoxRenderable; label: TextRenderable } {
  const fg = opts.fg ?? C.dark;
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1, backgroundColor: opts.bg,
  });
  const label = new TextRenderable(renderer, {
    content: text, fg, bg: opts.bg,
    attributes: TextAttributes.BOLD,
  });
  box.add(label);
  return { box, label };
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

export function buildTopBar(
  renderer: CliRenderer,
  opts: {
    version:     string;
    freeMode:    boolean;
    balanceUsd?: number;     // only shown when !freeMode
  },
): BoxRenderable {
  const prefs   = loadPrefs();
  const config  = loadConfig();
  const acct    = prefs.displayName
               || config.wallet_name
               || (config.addresses?.evm ? `${config.addresses.evm.slice(0, 6)}…${config.addresses.evm.slice(-4)}` : null)
               || 'guest';

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const brand = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, backgroundColor: C.panel,
  });
  brand.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS', fg: C.white, bg: C.panel, attributes: TextAttributes.BOLD,
  }));
  brand.add(new TextRenderable(renderer, {
    content: 'your private network, on demand', fg: C.dim, bg: C.panel,
  }));
  topBar.add(brand);

  const status = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 3, backgroundColor: C.panel,
  });
  status.add(new TextRenderable(renderer, { content: '● connected', fg: C.emerald, bg: C.panel }));
  status.add(new TextRenderable(renderer, { content: `acct ${acct}`, fg: C.slate, bg: C.panel }));
  // Free mode shows `tier free`; paid mode shows `bal $X.YZ`.
  status.add(new TextRenderable(renderer, {
    content: opts.freeMode
      ? 'tier free'
      : `bal $${(opts.balanceUsd ?? 0).toFixed(2)}`,
    fg: C.slate, bg: C.panel,
  }));
  status.add(new TextRenderable(renderer, { content: `v ${opts.version}`, fg: C.dim, bg: C.panel }));
  topBar.add(status);

  return topBar;
}

// ─── Breadcrumb row with TYPE toggle ─────────────────────────────────────────

export interface TypeToggleRefs {
  row:           BoxRenderable;
  fwdBox:        BoxRenderable; fwdLbl: TextRenderable;
  revBox:        BoxRenderable; revLbl: TextRenderable;
  setType:       (kind: 'forward' | 'reverse') => void;
  /** Append/replace a section label after the title ("· APP"). Empty clears. */
  setSection:    (label: string) => void;
}

export function buildBreadcrumb(
  renderer: CliRenderer,
  initial: 'forward' | 'reverse',
): TypeToggleRefs {
  const row = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingTop: 1,
    backgroundColor: C.dark,
  });

  // Breadcrumb left
  const breadcrumb = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });

  breadcrumb.add(new TextRenderable(renderer, {
    content: 'Proxies', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  breadcrumb.add(new TextRenderable(renderer, { content: '/', fg: C.dim, bg: C.dark }));
  const titleRef = new TextRenderable(renderer, {
    content: initial === 'forward' ? 'New forward proxy' : 'New reverse proxy',
    fg: C.slate, bg: C.dark,
  });
  breadcrumb.add(titleRef);

  // Section indicator — appended after the title when a section is active.
  // E.g. `Proxies / New forward proxy   ·  APP` so users always see where
  // their focus is.
  const sepRef = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  const sectionRef = new TextRenderable(renderer, {
    content: '', fg: C.accent, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  breadcrumb.add(sepRef);
  breadcrumb.add(sectionRef);

  row.add(breadcrumb);

  // TYPE toggle right
  const toggle = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  toggle.add(new TextRenderable(renderer, { content: 'TYPE', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));

  const fwdBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    backgroundColor: initial === 'forward' ? C.accent : C.line2,
  });
  const fwdLbl = new TextRenderable(renderer, {
    content: 'FORWARD',
    fg: initial === 'forward' ? C.dark : C.slate,
    bg: initial === 'forward' ? C.accent : C.line2,
    attributes: TextAttributes.BOLD,
  });
  fwdBox.add(fwdLbl);
  const revBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    backgroundColor: initial === 'reverse' ? C.accent : C.line2,
  });
  const revLbl = new TextRenderable(renderer, {
    content: 'REVERSE',
    fg: initial === 'reverse' ? C.dark : C.slate,
    bg: initial === 'reverse' ? C.accent : C.line2,
    attributes: TextAttributes.BOLD,
  });
  revBox.add(revLbl);
  toggle.add(fwdBox);
  toggle.add(revBox);
  row.add(toggle);

  const setType = (kind: 'forward' | 'reverse'): void => {
    titleRef.content = kind === 'forward' ? 'New forward proxy' : 'New reverse proxy';
    fwdBox.backgroundColor = kind === 'forward' ? C.accent : C.line2;
    fwdLbl.bg              = kind === 'forward' ? C.accent : C.line2;
    fwdLbl.fg              = kind === 'forward' ? C.dark   : C.slate;
    revBox.backgroundColor = kind === 'reverse' ? C.accent : C.line2;
    revLbl.bg              = kind === 'reverse' ? C.accent : C.line2;
    revLbl.fg              = kind === 'reverse' ? C.dark   : C.slate;
  };

  const setSection = (label: string): void => {
    if (label) {
      sepRef.content     = '  ·  ';
      sectionRef.content = label;
    } else {
      sepRef.content     = '';
      sectionRef.content = '';
    }
  };

  return { row, fwdBox, fwdLbl, revBox, revLbl, setType, setSection };
}

// ─── Subtitle ────────────────────────────────────────────────────────────────

export function buildSubtitle(renderer: CliRenderer, text: string): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    width: '100%', paddingX: 2, paddingBottom: 1, backgroundColor: C.dark,
  });
  box.add(new TextRenderable(renderer, { content: text, fg: C.dim, bg: C.dark }));
  return box;
}

// ─── DETECTED · LOCALHOST panel ──────────────────────────────────────────────

export interface DetectedPanelRefs {
  box:        BoxRenderable;
  rescanLbl:  TextRenderable;
  countLbl:   TextRenderable;
  setProcesses(procs: DiscoveredProcess[]): void;
  setFocused (idx:   number | null): void;
}

const DCOLS = { num: 3, pid: 6, port: 6, service: 9, entry: 22 };
const MAX_DETECTED_ROWS = 5;

export function buildDetectedPanel(
  renderer: CliRenderer,
): DetectedPanelRefs {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' DETECTED · LOCALHOST ', padding: 1,
    backgroundColor: C.dark,
  });

  // Header
  const header = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, paddingLeft: 1, backgroundColor: C.dark,
  });
  const mkHead = (text: string, w: number) => {
    header.add(new TextRenderable(renderer, {
      content: text.padEnd(w), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
    }));
  };
  mkHead('#',          DCOLS.num);
  mkHead('PID',        DCOLS.pid);
  mkHead('PORT',       DCOLS.port);
  mkHead('SERVICE',    DCOLS.service);
  mkHead('ENTRY FILE', DCOLS.entry);
  box.add(header);

  interface RowRefs {
    row:   BoxRenderable;
    badge: { box: BoxRenderable; label: TextRenderable };
    pid:   TextRenderable;
    port:  TextRenderable;
    svc:   TextRenderable;
    entry: TextRenderable;
  }
  const rows: RowRefs[] = [];
  for (let i = 0; i < MAX_DETECTED_ROWS; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center', paddingLeft: 1,
      border: ['left'], borderColor: C.dark,
      backgroundColor: C.dark,
    });
    const badge = makeBadge(renderer, ' ', { bg: C.line2 });
    const pid   = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const port  = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark });
    const svc   = new TextRenderable(renderer, { content: '', fg: C.white,  bg: C.dark });
    const entry = new TextRenderable(renderer, { content: '', fg: C.dim,    bg: C.dark });
    row.add(badge.box);
    row.add(pid);
    row.add(port);
    row.add(svc);
    row.add(entry);
    box.add(row);
    rows.push({ row, badge, pid, port, svc, entry });
  }

  // Footer: R rescan · N ports · 1-N use as app
  const footer = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', paddingTop: 1, backgroundColor: C.dark,
  });
  footer.add(makeBadge(renderer, 'R', { bg: C.slate }).box);
  const rescanLbl = new TextRenderable(renderer, { content: 'rescan', fg: C.slate, bg: C.dark });
  const countLbl  = new TextRenderable(renderer, { content: '',       fg: C.dim,   bg: C.dark });
  footer.add(rescanLbl);
  footer.add(countLbl);
  footer.add(new TextRenderable(renderer, { content: '·', fg: C.dim, bg: C.dark }));
  footer.add(makeBadge(renderer, '1-3', { bg: C.slate }).box);
  footer.add(new TextRenderable(renderer, { content: 'use as app', fg: C.slate, bg: C.dark }));
  box.add(footer);

  let procs: DiscoveredProcess[] = [];
  let focused: number | null = null;

  const shortenEntry = (entryFile: string | null): string => {
    if (!entryFile) return '—';
    const parts = entryFile.split('/');
    if (parts.length < 3) return entryFile;
    return `…/${parts.slice(-2).join('/')}`;
  };

  const repaint = (): void => {
    for (let i = 0; i < MAX_DETECTED_ROWS; i++) {
      const ref = rows[i]!;
      const p   = procs[i];
      if (!p) {
        ref.badge.box.backgroundColor = C.dark;
        ref.badge.label.bg = C.dark; ref.badge.label.content = ' ';
        ref.pid.content   = '';
        ref.port.content  = '';
        ref.svc.content   = '';
        ref.entry.content = '';
        ref.row.borderColor = C.dark;
        continue;
      }
      const n = i + 1;
      ref.badge.box.backgroundColor = C.accent;
      ref.badge.label.bg = C.accent; ref.badge.label.fg = C.dark;
      ref.badge.label.content = String(n);
      ref.pid.content   = String(p.pid).padEnd(DCOLS.pid);
      ref.port.content  = String(p.port).padEnd(DCOLS.port);
      ref.svc.content   = p.service.padEnd(DCOLS.service);
      ref.entry.content = shortenEntry(p.entryFile);
      ref.row.borderColor = i === focused ? C.accent : C.dark;
    }
    countLbl.content = ` · ${procs.length} port${procs.length === 1 ? '' : 's'}`;
  };

  return {
    box, rescanLbl, countLbl,
    setProcesses: (p) => { procs = p; repaint(); },
    setFocused:   (i) => { focused = i; repaint(); },
  };
}

// ─── BOOKMARKS panel ─────────────────────────────────────────────────────────

export interface BookmarksPanelRefs {
  box: BoxRenderable;
  setBookmarks(items: Bookmark[]): void;
}

const MAX_BM_ROWS = 5;

function timeAgo(ms: number): string {
  const dt = Date.now() - ms;
  const h  = Math.floor(dt / 3_600_000);
  const d  = Math.floor(h / 24);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${Math.max(1, Math.floor(dt / 60_000))}m`;
}

export function buildBookmarksPanel(renderer: CliRenderer): BookmarksPanelRefs {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' BOOKMARKS ', padding: 1,
    backgroundColor: C.dark,
  });

  interface RowRefs {
    row:   BoxRenderable;
    badge: { box: BoxRenderable; label: TextRenderable };
    name:  TextRenderable;
    port:  TextRenderable;
    age:   TextRenderable;
  }
  const rows: RowRefs[] = [];
  for (let i = 0; i < MAX_BM_ROWS; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center', paddingLeft: 1, backgroundColor: C.dark,
    });
    const badge = makeBadge(renderer, ' ', { bg: C.line2 });
    const name  = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark });
    const port  = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark });
    const age   = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
    row.add(badge.box);
    row.add(name);
    row.add(port);
    row.add(age);
    box.add(row);
    rows.push({ row, badge, name, port, age });
  }

  // Footer: M save current · O load
  const footer = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', paddingTop: 1, backgroundColor: C.dark,
  });
  footer.add(makeBadge(renderer, 'M', { bg: C.slate }).box);
  footer.add(new TextRenderable(renderer, { content: 'save current  ·', fg: C.slate, bg: C.dark }));
  footer.add(makeBadge(renderer, 'O', { bg: C.slate }).box);
  footer.add(new TextRenderable(renderer, { content: 'load', fg: C.slate, bg: C.dark }));
  box.add(footer);

  const setBookmarks = (items: Bookmark[]): void => {
    for (let i = 0; i < MAX_BM_ROWS; i++) {
      const ref = rows[i]!;
      const bm  = items[i];
      if (!bm) {
        ref.badge.box.backgroundColor = C.dark;
        ref.badge.label.bg = C.dark; ref.badge.label.content = ' ';
        ref.name.content = '';
        ref.port.content = '';
        ref.age.content  = '';
        continue;
      }
      ref.badge.box.backgroundColor = C.accent;
      ref.badge.label.bg = C.accent; ref.badge.label.fg = C.dark;
      ref.badge.label.content = String(i + 1);
      ref.name.content = bm.label.padEnd(20);
      ref.port.content = (bm.port ? `:${bm.port}` : bm.target).padEnd(8);
      ref.age.content  = timeAgo(bm.createdAt);
    }
  };

  return { box, setBookmarks };
}

// ─── WALLET panel ────────────────────────────────────────────────────────────

export function buildWalletPanel(
  renderer: CliRenderer,
  opts: { freeMode: boolean; hasEvm: boolean; hasSvm: boolean; hasIcp: boolean },
): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' WALLET ', padding: 1,
    backgroundColor: C.dark,
  });

  if (opts.freeMode) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
    });
    row.add(new TextRenderable(renderer, { content: '○', fg: C.dim, bg: C.dark }));
    row.add(new TextRenderable(renderer, {
      content: 'Free mode — no wallet required', fg: C.slate, bg: C.dark,
    }));
    box.add(row);
    return box;
  }

  const row = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', backgroundColor: C.dark,
  });
  const left = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  left.add(new TextRenderable(renderer, { content: '●', fg: C.emerald, bg: C.dark }));
  left.add(new TextRenderable(renderer, {
    content: 'self-managed', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  row.add(left);

  const right = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const flag = (label: string, present: boolean) => {
    right.add(new TextRenderable(renderer, {
      content: `${label} ${present ? '✓' : '✗'}`,
      fg: present ? C.emerald : C.dim, bg: C.dark,
    }));
  };
  flag('EVM', opts.hasEvm);
  flag('SVM', opts.hasSvm);
  flag('ICP', opts.hasIcp);
  row.add(right);
  box.add(row);
  return box;
}

// ─── Network family chips ────────────────────────────────────────────────────

export interface NetworkChipRefs {
  row:   BoxRenderable;
  setSelected(family: NetworkFamily): void;
}

export function buildNetworkChips(
  renderer: CliRenderer,
  initial: NetworkFamily,
): NetworkChipRefs {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  type ChipRef = { box: BoxRenderable; lbl: TextRenderable; fam: NetworkFamily };
  const chips: ChipRef[] = [];
  for (const fam of ['evm', 'svm', 'icp'] as NetworkFamily[]) {
    const chipBox = new BoxRenderable(renderer, {
      flexDirection: 'row', paddingX: 1,
      backgroundColor: fam === initial ? C.emerald : C.line2,
    });
    const lbl = new TextRenderable(renderer, {
      content: FAMILY_LABEL[fam],
      fg: fam === initial ? C.dark : C.slate,
      bg: fam === initial ? C.emerald : C.line2,
      attributes: TextAttributes.BOLD,
    });
    chipBox.add(lbl);
    row.add(chipBox);
    chips.push({ box: chipBox, lbl, fam });
  }
  row.add(new TextRenderable(renderer, { content: 'USDC', fg: C.dim, bg: C.dark }));

  const setSelected = (active: NetworkFamily): void => {
    for (const c of chips) {
      const on = c.fam === active;
      c.box.backgroundColor = on ? C.emerald : C.line2;
      c.lbl.bg              = on ? C.emerald : C.line2;
      c.lbl.fg              = on ? C.dark    : C.slate;
    }
  };

  return { row, setSelected };
}

// ─── Chain chips (depends on family) ─────────────────────────────────────────

export interface ChainChipRefs {
  row: BoxRenderable;
  /** Rebuild the chips to match the chains in `family`, marking `activeCaip2` as selected. */
  setFamily(family: NetworkFamily, activeCaip2: string): void;
  /** Update only the selection within the current family. */
  setActive(activeCaip2: string): void;
  /** Current chains in the order they're displayed — for keyboard nav. */
  getChains(): Array<{ label: string; caip2: string }>;
}

export function buildChainChips(
  renderer: CliRenderer,
  initialFamily: NetworkFamily,
  initialCaip2: string,
): ChainChipRefs {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });

  type ChipRef = { box: BoxRenderable; lbl: TextRenderable; caip2: string };
  let chips:   ChipRef[] = [];
  let chains   = CHAINS_BY_FAMILY[initialFamily];

  const wipe = (): void => {
    for (const c of chips) row.remove(c.box.id);
    chips = [];
  };

  const build = (family: NetworkFamily, activeCaip2: string): void => {
    wipe();
    chains = CHAINS_BY_FAMILY[family];
    for (let i = 0; i < chains.length; i++) {
      const ch = chains[i]!;
      const on = ch.caip2 === activeCaip2;
      const box = new BoxRenderable(renderer, {
        id: `chainchip-${family}-${i}`,
        flexDirection: 'row', paddingX: 1,
        backgroundColor: on ? C.sky : C.line2,
      });
      const lbl = new TextRenderable(renderer, {
        content: ch.label,
        fg: on ? C.dark : C.slate,
        bg: on ? C.sky  : C.line2,
        attributes: TextAttributes.BOLD,
      });
      box.add(lbl);
      row.add(box);
      chips.push({ box, lbl, caip2: ch.caip2 });
    }
  };

  build(initialFamily, initialCaip2);

  const setActive = (activeCaip2: string): void => {
    for (const c of chips) {
      const on = c.caip2 === activeCaip2;
      c.box.backgroundColor = on ? C.sky : C.line2;
      c.lbl.bg              = on ? C.sky : C.line2;
      c.lbl.fg              = on ? C.dark : C.slate;
    }
  };

  return {
    row,
    setFamily: build,
    setActive,
    getChains: () => chains,
  };
}

// ─── Footer chip strip ───────────────────────────────────────────────────────

export interface FooterHint { key: string; label: string }

export function buildFooter(
  renderer: CliRenderer,
  hints: FooterHint[],
  rightLabel: string,
): { box: BoxRenderable; setHints(items: FooterHint[]): void } {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });

  const chipGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.panel,
  });
  box.add(chipGroup);
  box.add(new TextRenderable(renderer, { content: rightLabel, fg: C.dim, bg: C.panel }));

  const renderHints = (items: FooterHint[]): void => {
    // Wipe + rebuild — small list, cheap.
    while (chipGroup.getChildrenCount() > 0) {
      const id = chipGroup.getChildren()[0]?.id;
      if (id != null) chipGroup.remove(id); else break;
    }
    for (const h of items) {
      const pair = new BoxRenderable(renderer, {
        id: `hint-${h.key}-${h.label}`,
        flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel,
      });
      pair.add(makeBadge(renderer, h.key, { bg: C.slate }).box);
      pair.add(new TextRenderable(renderer, { content: h.label, fg: C.slate, bg: C.panel }));
      chipGroup.add(pair);
    }
  };
  renderHints(hints);

  return { box, setHints: renderHints };
}

// ─── Form-field helpers ──────────────────────────────────────────────────────

export interface FieldRowRefs {
  row:    BoxRenderable;
  label:  TextRenderable;
  inputBox: BoxRenderable;
  inputText: TextRenderable;
  hint:   TextRenderable;
}

/**
 * One labelled input row: `LABEL  [input box]  hint`.
 * The caller drives `inputText.content` and the input box's `borderColor` for
 * focus state. `setEditing(on)` flips the focused styling.
 */
export function makeFieldRow(
  renderer: CliRenderer,
  labelText: string,
  hintText:  string,
  opts: { labelWidth?: number; inputWidth?: number; placeholder?: string } = {},
): FieldRowRefs {
  const labelWidth = opts.labelWidth ?? 14;
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  const label = new TextRenderable(renderer, {
    content: labelText.padEnd(labelWidth), fg: C.dim, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const inputBox = new BoxRenderable(renderer, {
    flexGrow: opts.inputWidth ? 0 : 1,
    width:    opts.inputWidth,
    flexDirection: 'row', paddingX: 1,
    border: ['top','right','bottom','left'],
    borderColor: C.line2, borderStyle: 'rounded',
    backgroundColor: C.panel,
  });
  const inputText = new TextRenderable(renderer, {
    content: opts.placeholder ?? ' ',
    fg: opts.placeholder ? C.dim : C.white,
    bg: C.panel,
  });
  inputBox.add(inputText);
  const hint = new TextRenderable(renderer, {
    content: hintText, fg: C.dim, bg: C.dark,
  });
  row.add(label);
  row.add(inputBox);
  row.add(hint);
  return { row, label, inputBox, inputText, hint };
}

// ─── Section header ──────────────────────────────────────────────────────────

export function makeSectionHeader(renderer: CliRenderer, title: string): TextRenderable {
  return new TextRenderable(renderer, {
    content: title, fg: C.dim, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
}

// ─── Toggle (two-state on/off or A/B) ────────────────────────────────────────

export interface ToggleRefs {
  row:   BoxRenderable;
  aBox:  BoxRenderable; aLbl: TextRenderable;
  bBox:  BoxRenderable; bLbl: TextRenderable;
  setActive(side: 'a' | 'b'): void;
}

export function makeToggle(
  renderer: CliRenderer,
  aLabel: string,
  bLabel: string,
  initial: 'a' | 'b' = 'a',
): ToggleRefs {
  const row = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 0, alignItems: 'center', backgroundColor: C.dark,
  });
  const aBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    backgroundColor: initial === 'a' ? C.sky : C.line2,
  });
  const aLbl = new TextRenderable(renderer, {
    content: aLabel,
    fg: initial === 'a' ? C.dark : C.slate,
    bg: initial === 'a' ? C.sky  : C.line2,
    attributes: TextAttributes.BOLD,
  });
  aBox.add(aLbl);
  const bBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    backgroundColor: initial === 'b' ? C.sky : C.line2,
  });
  const bLbl = new TextRenderable(renderer, {
    content: bLabel,
    fg: initial === 'b' ? C.dark : C.slate,
    bg: initial === 'b' ? C.sky  : C.line2,
    attributes: TextAttributes.BOLD,
  });
  bBox.add(bLbl);
  row.add(aBox);
  row.add(bBox);

  const setActive = (side: 'a' | 'b'): void => {
    aBox.backgroundColor = side === 'a' ? C.sky : C.line2;
    aLbl.bg              = side === 'a' ? C.sky : C.line2;
    aLbl.fg              = side === 'a' ? C.dark : C.slate;
    bBox.backgroundColor = side === 'b' ? C.sky : C.line2;
    bLbl.bg              = side === 'b' ? C.sky : C.line2;
    bLbl.fg              = side === 'b' ? C.dark : C.slate;
  };

  return { row, aBox, aLbl, bBox, bLbl, setActive };
}
