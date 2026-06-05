import crypto from 'node:crypto';
import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../../theme';
import { makeBadge } from '../../chrome.ts';
import { writeTraceLog } from '../../../lib/crash-log';
import { scanAll, scanLan, LAN_HTTP_PORTS, type ScannedPort, type LanDevice } from '../../../lib/ports.ts';
import { showTunnelDashboard } from './dashboard.ts';
import { makeSpin } from '../../../lib/spinners.ts';
import {
  loadPrefs, loadConfig,
  loadBookmarks, saveBookmark,
  type Bookmark,
} from '../../../lib/store.ts';

export type TunnelSetupResult = {
  protocol: 'http' | 'tcp';
  target:   string;
  port?:    number;
};
const TUNNEL_DOMAIN   = 'consensus.canister.software';
const NUMBER_KEYS_MAX = 7;
const MAX_BOOKMARKS   = 5;
const MIN_SPIN_MS     = 600;

function previewSlug(protocol: 'http' | 'tcp', target: string, port: string): string {
  const seed = `${protocol}:${target.trim().toLowerCase()}:${port.trim()}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 4);
}

function previewTcpPort(seed: string): number {
  const h = crypto.createHash('sha1').update(seed).digest();
  const n = h.readUInt16BE(0);
  return 1024 + (n % (65535 - 1024));
}

function timeAgo(ms: number): string {
  const dt = Date.now() - ms;
  const h  = Math.floor(dt / 3_600_000);
  const d  = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(dt / 60_000);
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function shortAddress(addr?: string): string | null {
  if (!addr) return null;
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function showTunnelSetup(): Promise<TunnelSetupResult | null> {
  const prefs   = loadPrefs();
  const config  = loadConfig();
  const version = '0.1.0-beta.7';   // TODO: read from package.json once we lift the parser

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding       = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const brandGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, backgroundColor: C.panel,
  });
  brandGroup.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS', fg: C.white, bg: C.panel, attributes: TextAttributes.BOLD,
  }));
  brandGroup.add(new TextRenderable(renderer, {
    content: 'your private network, on demand', fg: C.dim, bg: C.panel,
  }));
  topBar.add(brandGroup);

  const statusGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 3, backgroundColor: C.panel,
  });
  const acct = prefs.displayName || shortAddress(config.addresses?.evm) || 'guest';
  statusGroup.add(new TextRenderable(renderer, { content: '● connected',     fg: C.emerald, bg: C.panel }));
  statusGroup.add(new TextRenderable(renderer, { content: `acct ${acct}`,    fg: C.slate,   bg: C.panel }));
  statusGroup.add(new TextRenderable(renderer, { content: 'tier free',       fg: C.slate,   bg: C.panel }));
  statusGroup.add(new TextRenderable(renderer, { content: `v ${version}`,    fg: C.dim,     bg: C.panel }));
  topBar.add(statusGroup);
  root.add(topBar);

  const subHeader = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });

  const breadcrumb = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  breadcrumb.add(new TextRenderable(renderer, { content: 'Tunnels', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD }));
  breadcrumb.add(new TextRenderable(renderer, { content: '/',       fg: C.dim,   bg: C.dark }));
  breadcrumb.add(new TextRenderable(renderer, { content: 'New tunnel', fg: C.slate, bg: C.dark }));
  subHeader.add(breadcrumb);

  const protocolGroup = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark, });
  protocolGroup.add(makeBadge(renderer, 'P', { bg: C.slate }).box);
  protocolGroup.add(new TextRenderable(renderer, { content: 'PROTOCOL', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const protoHttpBox = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: C.accent });
  const protoHttpLbl = new TextRenderable(renderer, { content: 'HTTP', fg: C.dark, bg: C.accent, attributes: TextAttributes.BOLD });
  protoHttpBox.add(protoHttpLbl);
  const protoTcpBox  = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: C.line2 });
  const protoTcpLbl  = new TextRenderable(renderer, { content: 'TCP', fg: C.slate, bg: C.line2, attributes: TextAttributes.BOLD });
  protoTcpBox.add(protoTcpLbl);
  protocolGroup.add(protoHttpBox);
  protocolGroup.add(protoTcpBox);
  subHeader.add(protocolGroup);
  root.add(subHeader);

  const subtitle = new BoxRenderable(renderer, {
    width: '100%', paddingX: 2, paddingBottom: 1, backgroundColor: C.dark,
  });
  subtitle.add(new TextRenderable(renderer, {
    content: "pick a local process or LAN device — we'll mint the public URL",
    fg: C.dim, bg: C.dark,
  }));
  root.add(subtitle);

  type Section = 'lists' | 'target' | 'port' | 'bookmarks';

  let protocol: 'http' | 'tcp' = (prefs.defaultProtocol === 'tcp' ? 'tcp' : 'http');
  let target:   string         = prefs.defaultTarget ?? '';
  let portStr:  string         = '';
  let localPorts:  ScannedPort[] = [];
  let lanDevices:  LanDevice[]   = [];
  let showAllLan = false;
  let section: Section = 'lists';
  let listIdx  = 0;
  let bookmarks = loadBookmarks().filter(b => b.type === 'tunnel-http' || b.type === 'tunnel-tcp');
  let editingTarget = false;
  let editingPort   = false;
  let lanScanned    = false;
  let cursorOn = true;
  let localSpinTicker: ReturnType<typeof setInterval> | null = null;
  let lanSpinTicker:   ReturnType<typeof setInterval> | null = null;

  const body = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    gap: 1, paddingX: 2, backgroundColor: C.dark,
  });
  root.add(body);

  const listsRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2, backgroundColor: C.dark,
  });

  const localPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' LOCAL PROCESSES ', padding: 1,
    backgroundColor: C.dark,
  });
  const lanPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    border: true, borderStyle: 'single', borderColor: C.line2,
    title: ' LAN DEVICES ', padding: 1,
    backgroundColor: C.dark,
  });
  listsRow.add(localPanel);
  listsRow.add(lanPanel);
  body.add(listsRow);

  const ROW_COUNT_LOCAL = 5;
  const ROW_COUNT_LAN   = 5;
  const LCOLS = { num: 3, port: 7, process: 24 };
  const NCOLS = { num: 3, ip: 16, host: 26, ports: 12 };

  const mkLocalHeader = () => {
    const h = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, paddingLeft: 2, backgroundColor: C.dark });
    h.add(new TextRenderable(renderer, { content: '#'.padEnd(LCOLS.num),       fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    h.add(new TextRenderable(renderer, { content: 'PORT'.padEnd(LCOLS.port),   fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    h.add(new TextRenderable(renderer, { content: 'PROCESS'.padEnd(LCOLS.process), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    return h;
  };
  const mkLanHeader = () => {
    const h = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, paddingLeft: 2, backgroundColor: C.dark });
    h.add(new TextRenderable(renderer, { content: '#'.padEnd(NCOLS.num),   fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    h.add(new TextRenderable(renderer, { content: 'IP'.padEnd(NCOLS.ip),   fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    h.add(new TextRenderable(renderer, { content: 'HOST'.padEnd(NCOLS.host), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    h.add(new TextRenderable(renderer, { content: 'PORTS'.padStart(NCOLS.ports), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    return h;
  };
  localPanel.add(mkLocalHeader());
  lanPanel.add(mkLanHeader());

  type LocalRowRefs = {
    box: BoxRenderable;
    badge: { box: BoxRenderable; label: TextRenderable };
    port: TextRenderable; process: TextRenderable;
  };
  type LanRowRefs = {
    box: BoxRenderable;
    badge: { box: BoxRenderable; label: TextRenderable };
    ip: TextRenderable; host: TextRenderable; ports: TextRenderable;
  };
  const localRowRefs: LocalRowRefs[] = [];
  const lanRowRefs:   LanRowRefs[]   = [];

  for (let i = 0; i < ROW_COUNT_LOCAL; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center', paddingLeft: 1,
      border: ['left'], borderColor: C.dark, backgroundColor: C.dark,
    });
    const badge = makeBadge(renderer, ' ', { bg: C.line2 });
    const port    = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const process = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark });
    row.add(badge.box); row.add(port); row.add(process);
    localPanel.add(row);
    localRowRefs.push({ box: row, badge, port, process });
  }
  const localFooter = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', paddingTop: 1, backgroundColor: C.dark,
  });
  const localRescanChip = makeBadge(renderer, 'R', { bg: C.slate }).box;
  const localFooterText = new TextRenderable(renderer, { content: 'rescan local', fg: C.slate, bg: C.dark });
  const localCountText  = new TextRenderable(renderer, { content: '',             fg: C.dim,   bg: C.dark });
  localFooter.add(localRescanChip);
  localFooter.add(localFooterText);
  localFooter.add(localCountText);
  localPanel.add(localFooter);

  for (let i = 0; i < ROW_COUNT_LAN; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center', paddingLeft: 1,
      border: ['left'], borderColor: C.dark, backgroundColor: C.dark,
    });
    const badge = makeBadge(renderer, ' ', { bg: C.line2 });
    const ip    = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const host  = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark });
    const ports = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark });
    row.add(badge.box); row.add(ip); row.add(host); row.add(ports);
    lanPanel.add(row);
    lanRowRefs.push({ box: row, badge, ip, host, ports });
  }
  const lanFooter = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', paddingTop: 1, backgroundColor: C.dark,
  });
  const lanHiddenText = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
  const lanShowChip   = makeBadge(renderer, 'A', { bg: C.slate }).box;
  const lanShowLbl    = new TextRenderable(renderer, { content: 'show all',  fg: C.slate, bg: C.dark });
  const lanSep        = new TextRenderable(renderer, { content: '·',          fg: C.dim,   bg: C.dark });
  const lanRescanChip = makeBadge(renderer, 'L', { bg: C.slate }).box;
  const lanRescanLbl  = new TextRenderable(renderer, { content: 'rescan LAN', fg: C.slate, bg: C.dark });
  lanFooter.add(lanHiddenText);
  lanFooter.add(lanShowChip);
  lanFooter.add(lanShowLbl);
  lanFooter.add(lanSep);
  lanFooter.add(lanRescanChip);
  lanFooter.add(lanRescanLbl);
  lanPanel.add(lanFooter);

  const targetPanel = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row',
    border: true, borderStyle: 'single', borderColor: C.emerald,
    title: ' TARGET ', padding: 1, gap: 2,
    backgroundColor: C.dark,
  });

  const targetForm = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column', gap: 1,
    backgroundColor: C.dark,
  });

  const targetRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  targetRow.add(new TextRenderable(renderer, { content: 'TARGET', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const targetInputBox = new BoxRenderable(renderer, {
    flexGrow: 1, flexDirection: 'row', paddingX: 1,
    border: ['top', 'right', 'bottom', 'left'], borderColor: C.line2, borderStyle: 'rounded',
    backgroundColor: C.panel,
  });
  const targetInputText = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.panel });
  targetInputBox.add(targetInputText);
  targetRow.add(targetInputBox);
  targetForm.add(targetRow);
  targetForm.add(new TextRenderable(renderer, { content: 'IP address or hostname', fg: C.dim, bg: C.dark }));

  const portRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  portRow.add(new TextRenderable(renderer, { content: 'PORT  ', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const portInputBox = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1,
    border: ['top', 'right', 'bottom', 'left'], borderColor: C.line2, borderStyle: 'rounded',
    backgroundColor: C.panel,
  });
  const portInputText = new TextRenderable(renderer, { content: '    ', fg: C.white, bg: C.panel });
  portInputBox.add(portInputText);
  portRow.add(portInputBox);
  const portHelpText = new TextRenderable(renderer, {
    content: 'optional — leave blank to use default', fg: C.dim, bg: C.dark,
  });
  portRow.add(portHelpText);
  targetForm.add(portRow);

  targetPanel.add(targetForm);

  const targetRight = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column', gap: 1,
    backgroundColor: C.dark,
  });
  targetRight.add(new TextRenderable(renderer, { content: 'WILL CREATE', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const willUrlRef    = new TextRenderable(renderer, { content: '', fg: C.emerald, bg: C.dark, attributes: TextAttributes.BOLD });
  const willDetailRef = new TextRenderable(renderer, { content: '', fg: C.slate,   bg: C.dark });
  targetRight.add(willUrlRef);
  targetRight.add(willDetailRef);

  const startRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  const CREAM = '#faf4ee';
  const BTN_TEAL = C.sky;
  const startButton = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center',
    paddingX: 2, paddingY: 1, backgroundColor: BTN_TEAL,
  });
  const startChipBadge = makeBadge(renderer, 'S', { bg: CREAM, fg: BTN_TEAL });
  const startLabel = new TextRenderable(renderer, {
    content: 'START TUNNEL', fg: CREAM, bg: BTN_TEAL,
    attributes: TextAttributes.BOLD,
  });
  startButton.add(startChipBadge.box);
  startButton.add(startLabel);
  startRow.add(startButton);
  startRow.add(new TextRenderable(renderer, { content: 'or press ↵', fg: C.dim, bg: C.dark }));
  targetRight.add(startRow);

  targetPanel.add(targetRight);
  body.add(targetPanel);

  const bmHeader = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  bmHeader.add(new TextRenderable(renderer, { content: 'BOOKMARKS', fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  bmHeader.add(makeBadge(renderer, 'M', { bg: C.slate }).box);
  bmHeader.add(new TextRenderable(renderer, { content: 'save current  ·', fg: C.slate, bg: C.dark }));
  bmHeader.add(makeBadge(renderer, 'O', { bg: C.slate }).box);
  bmHeader.add(new TextRenderable(renderer, { content: 'load', fg: C.slate, bg: C.dark }));
  body.add(bmHeader);

  type BmRefs = { box: BoxRenderable; badge: { box: BoxRenderable; label: TextRenderable }; name: TextRenderable; proto: TextRenderable; target: TextRenderable; age: TextRenderable };
  const bmRefs: BmRefs[] = [];
  for (let i = 0; i < MAX_BOOKMARKS; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center', paddingLeft: 1, backgroundColor: C.dark,
    });
    const badge = makeBadge(renderer, '·', { bg: C.line2 });
    const name   = new TextRenderable(renderer, { content: '', fg: C.white, bg: C.dark });
    const proto  = new TextRenderable(renderer, { content: '', fg: C.accent, bg: C.dark });
    const target = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
    const age    = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
    row.add(badge.box); row.add(name); row.add(proto); row.add(target); row.add(age);
    body.add(row);
    bmRefs.push({ box: row, badge, name, proto, target, age });
  }

  const footer = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  const footerChips = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.panel,
  });
  type Hint = { key: string; label: string };
  const HINTS: Hint[] = [
    { key: '1-7',  label: 'select'       },
    { key: 'P',    label: 'protocol'     },
    { key: 'R',    label: 'rescan local' },
    { key: 'L',    label: 'scan LAN'     },
    { key: 'A',    label: 'show all'     },
    { key: 'M',    label: 'bookmark'     },
    { key: '⇧1-5', label: 'load bm'      },
    { key: '↵',    label: 'start'        },
    { key: 'B',    label: 'back'         },
  ];
  for (const h of HINTS) {
    const pair = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.panel });
    pair.add(makeBadge(renderer, h.key, { bg: C.slate }).box);
    pair.add(new TextRenderable(renderer, { content: h.label, fg: C.slate, bg: C.panel }));
    footerChips.add(pair);
  }
  footer.add(footerChips);
  footer.add(new TextRenderable(renderer, { content: 'TUNNEL SETUP', fg: C.dim, bg: C.panel }));
  root.add(footer);

  type Selectable =
    | { kind: 'local'; num: number; entry: ScannedPort }
    | { kind: 'lan';   num: number; entry: LanDevice };

  function visibleLanDevices(): LanDevice[] {
    return showAllLan ? lanDevices : lanDevices.filter(d => !d.isFiltered);
  }

  function buildSelectables(): Selectable[] {
    const out: Selectable[] = [];
    let n = 1;

    const localSlice = localPorts.slice(0, ROW_COUNT_LOCAL);
    for (const p of localSlice) {
      if (p.isSystem || n > NUMBER_KEYS_MAX) continue;
      out.push({ kind: 'local', num: n++, entry: p });
    }

    const lanSlice = visibleLanDevices().slice(0, ROW_COUNT_LAN);
    for (const d of lanSlice) {
      if (n > NUMBER_KEYS_MAX) break;
      out.push({ kind: 'lan', num: n++, entry: d });
    }
    return out;
  }

  function renderProtocol(): void {
    const httpActive = protocol === 'http';
    protoHttpBox.backgroundColor = httpActive ? C.accent : C.line2;
    protoHttpLbl.bg              = httpActive ? C.accent : C.line2;
    protoHttpLbl.fg              = httpActive ? C.dark   : C.slate;
    protoTcpBox.backgroundColor  = httpActive ? C.line2  : C.accent;
    protoTcpLbl.bg               = httpActive ? C.line2  : C.accent;
    protoTcpLbl.fg               = httpActive ? C.slate  : C.dark;
  }

  function renderLocalRows(): void {
    const selectables = buildSelectables();
    const localSel = new Map(selectables.filter(s => s.kind === 'local').map(s => [s.entry, s.num] as const));

    const localSlice = localPorts.slice(0, ROW_COUNT_LOCAL);
    for (let i = 0; i < ROW_COUNT_LOCAL; i++) {
      const ref = localRowRefs[i]!;
      const p = localSlice[i];
      if (!p) {
        ref.badge.box.backgroundColor = C.dark;
        ref.badge.label.bg = C.dark; ref.badge.label.content = ' ';
        ref.port.content = ''; ref.process.content = '';
        ref.box.borderColor = C.dark;
        continue;
      }
      const num    = localSel.get(p);
      const isSys  = p.isSystem;
      const text   = num != null ? String(num) : '—';
      const badgeBg = num != null ? C.accent : C.line2;
      const badgeFg = num != null ? C.dark   : C.dim;
      ref.badge.box.backgroundColor = badgeBg;
      ref.badge.label.bg = badgeBg; ref.badge.label.fg = badgeFg;
      ref.badge.label.content = text;
      ref.port.content    = `:${p.port}`.padEnd(LCOLS.port);
      ref.port.fg         = isSys ? C.dim : C.slate;
      ref.process.content = `${p.label}${p.isSystem ? ' · system' : p.process && p.process !== p.label ? ' · ' + p.process.split('/').pop()! : ''}`;
      ref.process.fg      = isSys ? C.dim : C.white;
      const isFocused = section === 'lists' && selectables[listIdx]?.kind === 'local' && selectables[listIdx]?.entry === p;
      ref.box.borderColor = isFocused && cursorOn ? C.accent : C.dark;
    }
    localCountText.content = ` · ${localPorts.filter(p => !p.isSystem).length} ports`;
  }

  function renderLanRows(): void {
    const selectables = buildSelectables();
    const lanSel = new Map(selectables.filter(s => s.kind === 'lan').map(s => [s.entry, s.num] as const));
    const visible = visibleLanDevices().slice(0, ROW_COUNT_LAN);

    for (let i = 0; i < ROW_COUNT_LAN; i++) {
      const ref = lanRowRefs[i]!;
      const d = visible[i];
      if (!d) {
        ref.badge.box.backgroundColor = C.dark;
        ref.badge.label.bg = C.dark; ref.badge.label.content = ' ';
        ref.ip.content = ''; ref.host.content = ''; ref.ports.content = '';
        ref.box.borderColor = C.dark;
        continue;
      }
      const num    = lanSel.get(d);
      const text   = num != null ? String(num) : '—';
      const badgeBg = num != null ? C.accent : C.line2;
      const badgeFg = num != null ? C.dark   : C.dim;
      ref.badge.box.backgroundColor = badgeBg;
      ref.badge.label.bg = badgeBg; ref.badge.label.fg = badgeFg;
      ref.badge.label.content = text;
      ref.ip.content    = d.ip.padEnd(NCOLS.ip);
      ref.host.content  = (d.hostname ?? d.ip).padEnd(NCOLS.host);
      ref.ports.content = (d.ports.length === 0 ? '—' : ':' + d.ports.slice(0, 2).join(', :')).padStart(NCOLS.ports);
      const isFocused = section === 'lists' && selectables[listIdx]?.kind === 'lan' && selectables[listIdx]?.entry === d;
      ref.box.borderColor = isFocused && cursorOn ? C.accent : C.dark;
    }
    const hiddenCount = lanDevices.length - visibleLanDevices().length;
    if (!lanScanned && lanDevices.length === 0) {
      lanHiddenText.content = 'press L to scan  ';
    } else {
      lanHiddenText.content = hiddenCount > 0 ? `${hiddenCount} devices hidden  ` : '';
    }
  }

  function renderTargetForm(): void {
    const tCaret = editingTarget && cursorOn ? '█' : (editingTarget ? ' ' : '');
    const pCaret = editingPort   && cursorOn ? '█' : (editingPort   ? ' ' : '');
    targetInputText.content = (target  || (editingTarget ? '' : ' ')) + tCaret;
    portInputText.content   = (portStr || (editingPort   ? '' : '    ')) + pCaret;

    targetInputBox.borderColor = section === 'target' ? C.accent : C.line2;
    portInputBox.borderColor   = section === 'port'   ? C.accent : C.line2;

    if (protocol === 'tcp' && portStr.trim() === '') {
      portHelpText.content = 'required for TCP';
      portHelpText.fg      = C.amber;
    } else {
      portHelpText.content = 'optional — leave blank to use default';
      portHelpText.fg      = C.dim;
    }
  }

  function renderWillCreate(): void {
    const slug = previewSlug(protocol, target, portStr);
    const portShown = portStr.trim() || (protocol === 'tcp' ? '—' : 'default');
    if (protocol === 'http') {
      willUrlRef.content    = `https://t-${slug}.${TUNNEL_DOMAIN}`;
    } else {
      const tcpPort = previewTcpPort(`${target}:${portStr || '0'}`);
      willUrlRef.content    = `tcp://t-${slug}.${TUNNEL_DOMAIN}:${tcpPort}`;
    }
    const targetForDetail = target.trim() || '—';
    willDetailRef.content = `→ ${targetForDetail}:${portShown}  ·  ${protocol}  ·  region auto  ·  free tier`;

    startButton.backgroundColor        = BTN_TEAL;
    startLabel.bg                      = BTN_TEAL;
    startLabel.fg                      = CREAM;
    startChipBadge.box.backgroundColor = CREAM;
    startChipBadge.label.bg            = CREAM;
    startChipBadge.label.fg            = BTN_TEAL;
  }

  function renderBookmarks(): void {
    for (let i = 0; i < MAX_BOOKMARKS; i++) {
      const ref = bmRefs[i]!;
      const b   = bookmarks[i];
      if (!b) {
        ref.badge.box.backgroundColor = C.dark;
        ref.badge.label.bg = C.dark; ref.badge.label.content = ' ';
        ref.name.content = ''; ref.proto.content = ''; ref.target.content = ''; ref.age.content = '';
        continue;
      }
      const num = i + 1;
      ref.badge.box.backgroundColor = C.accent;
      ref.badge.label.bg = C.accent; ref.badge.label.fg = C.dark;
      ref.badge.label.content = String(num);
      ref.name.content   = b.label.padEnd(20);
      ref.proto.content  = b.type === 'tunnel-tcp' ? 'tcp ' : 'http';
      ref.target.content = b.target.padEnd(28);
      ref.age.content    = timeAgo(b.createdAt);
    }
  }

  function renderAll(): void {
    renderProtocol();
    renderLocalRows();
    renderLanRows();
    renderTargetForm();
    renderWillCreate();
    renderBookmarks();
  }

  const spin = makeSpin('scan');

  async function withMinDelay<T>(p: Promise<T>): Promise<T> {
    const [v] = await Promise.all([p, new Promise(r => setTimeout(r, MIN_SPIN_MS))]);
    return v;
  }

  async function rescanLocal(): Promise<void> {
    if (localSpinTicker) return;                       // ignore re-entry
    localFooterText.fg = C.amber;
    localSpinTicker = setInterval(() => {
      localFooterText.content = `${spin()} rescanning…`;
    }, 120);
    try {
      localPorts = await withMinDelay(scanAll());
    } catch (e) {
      writeTraceLog('tunnel.setup.scanAll.failed', { err: String(e) });
      localPorts = [];
    }
    if (localSpinTicker) { clearInterval(localSpinTicker); localSpinTicker = null; }
    localFooterText.content = 'rescan local';
    localFooterText.fg      = C.slate;
    renderAll();
  }

  async function rescanLan(): Promise<void> {
    if (lanSpinTicker) return;
    lanScanned = true;
    lanRescanLbl.fg = C.amber;
    lanSpinTicker = setInterval(() => {
      lanRescanLbl.content = `${spin()} scanning…`;
    }, 120);
    try {
      lanDevices = await withMinDelay(scanLan(LAN_HTTP_PORTS));
    } catch (e) {
      writeTraceLog('tunnel.setup.scanLan.failed', { err: String(e) });
      lanDevices = [];
    }
    if (lanSpinTicker) { clearInterval(lanSpinTicker); lanSpinTicker = null; }
    lanRescanLbl.content = 'rescan LAN';
    lanRescanLbl.fg      = C.slate;
    renderAll();
  }

  function selectFromList(idx: number): void {
    const sels = buildSelectables();
    const s = sels[idx];
    if (!s) return;
    if (s.kind === 'local') {
      target  = 'localhost';
      portStr = String(s.entry.port);
    } else {
      target  = s.entry.ip;
      portStr = s.entry.ports[0] != null ? String(s.entry.ports[0]) : '';
    }
    listIdx = idx;
    renderAll();
  }

  function pickByNumber(n: number): void {
    const sels = buildSelectables();
    const idx = sels.findIndex(s => s.num === n);
    if (idx >= 0) selectFromList(idx);
  }

  renderAll();
  void rescanLocal();

  const blinkTimer = setInterval(() => {
    cursorOn = !cursorOn;
    renderAll();
  }, 500);

  return new Promise<TunnelSetupResult | null>((resolve) => {
    let alive = true;

    const teardown = (): void => {
      alive = false;
      clearInterval(blinkTimer);
      if (localSpinTicker) clearInterval(localSpinTicker);
      if (lanSpinTicker)   clearInterval(lanSpinTicker);
      renderer.destroy();
    };

    const done = (result: TunnelSetupResult | null): void => {
      teardown();
      resolve(result);
    };

    const startTunnel = async (): Promise<void> => {
      const isPreview = process.env.CONSENSUS_PREVIEW_TUNNEL === '1';
      if (!isPreview) {
        if (!target.trim()) return;                          // require target
        if (protocol === 'tcp' && !portStr.trim()) return;   // require port for tcp
      }
      const result: TunnelSetupResult = {
        protocol,
        target: (target.trim() || (isPreview ? 'localhost' : '')),
        port:   portStr.trim() ? Number(portStr.trim())
              : isPreview      ? 3000
              :                  undefined,
      };
      teardown();
      await showTunnelDashboard(result);
      resolve(null);                                       // back to landing on close
    };

    renderer.keyInput.on('keypress', (key) => {
      if (!alive) return;

      if (editingTarget || editingPort) {
        if (key.name === 'escape') {
          editingTarget = false; editingPort = false;
          renderAll(); return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          editingTarget = false; editingPort = false;
          renderAll(); return;
        }
        if (key.name === 'backspace') {
          if (editingTarget) target  = target.slice(0, -1);
          if (editingPort)   portStr = portStr.slice(0, -1);
          renderAll(); return;
        }
        const ch = key.sequence;
        if (typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch <= '~') {
          if (editingTarget) target  += ch;
          if (editingPort)   portStr += ch;
          renderAll(); return;
        }
        return;
      }

      if (key.ctrl && key.name === 'c')                       { done(null); return; }
      if (key.name === 'b' || key.name === 'B' || key.name === 'escape') { done(null); return; }

      if ((key.name === 'p' || key.name === 'P') && !key.shift) {
        protocol = protocol === 'http' ? 'tcp' : 'http';
        renderAll();
        return;
      }
      if (key.name === 'h' && !key.shift) { protocol = 'http'; renderAll(); return; }
      if (key.name === 't' && !key.shift) { protocol = 'tcp';  renderAll(); return; }

      const SHIFTED_DIGIT_SEQ: Record<string, number> = {
        '!': 0, '@': 1, '#': 2, '$': 3, '%': 4,
      };
      let bmIdx: number | null = null;
      if (key.shift && key.name && /^[1-5]$/.test(key.name)) {
        bmIdx = parseInt(key.name, 10) - 1;
      } else if (key.sequence && key.sequence in SHIFTED_DIGIT_SEQ) {
        bmIdx = SHIFTED_DIGIT_SEQ[key.sequence]!;
      }
      if (bmIdx !== null && bookmarks[bmIdx]) {
        const b = bookmarks[bmIdx]!;
        protocol = b.type === 'tunnel-tcp' ? 'tcp' : 'http';
        const [tHost, tPort] = b.target.split(':') as [string, string | undefined];
        target  = tHost;
        portStr = tPort ?? (b.port ? String(b.port) : '');
        renderAll();
        return;
      }

      if (!key.shift) {
        const n = key.name && /^[1-7]$/.test(key.name) ? parseInt(key.name, 10) : null;
        if (n != null) { pickByNumber(n); return; }
      }

      if (key.name === 'r' || key.name === 'R') { void rescanLocal(); return; }
      if (key.name === 'l' || key.name === 'L') { void rescanLan();   return; }
      if (key.name === 'a' || key.name === 'A') { showAllLan = !showAllLan; renderAll(); return; }

      if (key.name === 'm' || key.name === 'M') {
        if (!target.trim()) return;
        const bm: Bookmark = {
          id:       crypto.randomUUID(),
          label:    target.trim(),
          type:     protocol === 'tcp' ? 'tunnel-tcp' : 'tunnel-http',
          target:   `${target.trim()}${portStr.trim() ? ':' + portStr.trim() : ''}`,
          port:     portStr.trim() ? Number(portStr.trim()) : undefined,
          createdAt: Date.now(),
        };
        try { saveBookmark(bm); } catch { /* non-fatal */ }
        bookmarks = loadBookmarks().filter(b => b.type === 'tunnel-http' || b.type === 'tunnel-tcp');
        renderAll();
        return;
      }

      if (key.name === 'tab') {
        section = section === 'lists'  ? 'target'
                : section === 'target' ? 'port'
                : section === 'port'   ? 'bookmarks'
                :                        'lists';
        renderAll(); return;
      }
      if (key.name === 'up' || key.name === 'k') {
        if (section === 'lists') {
          const sels = buildSelectables();
          listIdx = Math.max(0, listIdx - 1);
          if (sels[listIdx]) selectFromList(listIdx);
        }
        renderAll(); return;
      }
      if (key.name === 'down' || key.name === 'j') {
        if (section === 'lists') {
          const sels = buildSelectables();
          listIdx = Math.min(Math.max(0, sels.length - 1), listIdx + 1);
          if (sels[listIdx]) selectFromList(listIdx);
        }
        renderAll(); return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (section === 'target') { editingTarget = true; renderAll(); return; }
        if (section === 'port')   { editingPort   = true; renderAll(); return; }
        void startTunnel();
        return;
      }
      if (key.name === 's' || key.name === 'S') {
        void startTunnel();
        return;
      }
    });
  });
}
