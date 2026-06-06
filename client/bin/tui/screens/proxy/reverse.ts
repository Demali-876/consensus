import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../../theme';
import { writeTraceLog } from '../../../lib/crash-log';
import { discoverAll, type DiscoveredProcess } from '../../../lib/discover.ts';
import { HTTP_PORTS, chooseDefaultPort, REVERSE_PROXY_PORT_CANDIDATES } from '../../../lib/ports.ts';
import { makeSpin } from '../../../lib/spinners.ts';
import { loadPrefs, loadBookmarks, saveBookmark, type Bookmark } from '../../../lib/store.ts';
import { isFreeMode } from '../../../lib/server-config';
import type { PreferNetwork } from '../../../../src/payment-fetch.js';
import {
  buildTopBar, buildBreadcrumb, buildSubtitle,
  buildDetectedPanel, buildBookmarksPanel, buildWalletPanel,
  buildNetworkChips, buildChainChips, buildFooter,
  makeFieldRow, makeSectionHeader, makeToggle,
  familyFromCaip2, FAMILY_DEFAULT_CAIP2, CHAINS_BY_FAMILY,
  type FooterHint, type NetworkFamily,
} from './setup-common.ts';
import crypto from 'node:crypto';

export type ReverseSetupResult = {
  upstream:       { host: string; port: number; protocol: 'http' | 'https' };
  listenPort:     number;
  cacheTtl:       number;   // ms
  cacheMaxSize:   number;
  preferNetwork?: PreferNetwork;
};

export type ReverseSetupOutcome =
  | { kind: 'result'; data: ReverseSetupResult }
  | { kind: 'cancel' }
  | { kind: 'swap-to-forward' };

export type ReverseSetupReturn = ReverseSetupResult | null | { swap: 'forward' };

export async function showReverseSetup(): Promise<ReverseSetupReturn> {
  const outcome = await showReverseSetupInternal();
  if (outcome.kind === 'result')         return outcome.data;
  if (outcome.kind === 'swap-to-forward') return { swap: 'forward' };
  return null;
}

type FieldId =
  | 'host' | 'port' | 'protocol'
  | 'listenPort'
  | 'cacheTtl' | 'maxEntries'
  | 'family' | 'chain';

type FieldSection = 'UPSTREAM' | 'PROXY' | 'CACHE' | 'NETWORK';
const FIELD_SECTION: Record<FieldId, FieldSection> = {
  host:       'UPSTREAM',
  port:       'UPSTREAM',
  protocol:   'UPSTREAM',
  listenPort: 'PROXY',
  cacheTtl:   'CACHE',
  maxEntries: 'CACHE',
  family:     'NETWORK',
  chain:      'NETWORK',
};

interface FieldState {
  id:       FieldId;
  value:    string;
  options?: string[];
}

async function showReverseSetupInternal(): Promise<ReverseSetupOutcome> {
  const prefs    = loadPrefs();
  const version  = '0.1.0-beta.7';
  const freeMode = await isFreeMode();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  root.add(buildTopBar(renderer, { version, freeMode }));
  const crumb = buildBreadcrumb(renderer, 'reverse');
  root.add(crumb.row);
  root.add(buildSubtitle(renderer, 'expose a local upstream through a cached, paid reverse proxy'));

  const body = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    paddingX: 2, backgroundColor: C.dark,
  });
  root.add(body);

  const leftCol = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column', gap: 1, backgroundColor: C.dark,
  });
  const detected = buildDetectedPanel(renderer);
  leftCol.add(detected.box);
  const bookmarksPanel = buildBookmarksPanel(renderer);
  leftCol.add(bookmarksPanel.box);
  const hasEvm = Boolean(process.env.CONSENSUS_EVM_KEY);
  const hasSvm = Boolean(process.env.CONSENSUS_SVM_KEY);
  const hasIcp = Boolean(process.env.CONSENSUS_PEM_PATH);
  leftCol.add(buildWalletPanel(renderer, { freeMode, hasEvm, hasSvm, hasIcp }));
  body.add(leftCol);

  const rightCol = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column', gap: 1, backgroundColor: C.dark,
  });
  body.add(rightCol);

  rightCol.add(makeSectionHeader(renderer, 'UPSTREAM'));
  const hostRow = makeFieldRow(renderer, 'Host', 'upstream host');
  const portRow = makeFieldRow(renderer, 'Port', 'upstream port', { inputWidth: 12 });
  const protoRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  protoRow.add(new TextRenderable(renderer, { content: 'Protocol'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const protoToggle = makeToggle(renderer, 'http', 'https', 'a');
  protoRow.add(protoToggle.row);
  rightCol.add(hostRow.row);
  rightCol.add(portRow.row);
  rightCol.add(protoRow);

  rightCol.add(makeSectionHeader(renderer, 'PROXY'));
  const listenPortRow = makeFieldRow(renderer, 'Listen port', 'local proxy bind port', { inputWidth: 12 });
  rightCol.add(listenPortRow.row);

  rightCol.add(makeSectionHeader(renderer, 'CACHE'));
  const ttlRow      = makeFieldRow(renderer, 'Cache TTL',   'sec · 0 = off',     { inputWidth: 12 });
  const maxRow      = makeFieldRow(renderer, 'Max entries', 'cached responses',  { inputWidth: 12 });
  rightCol.add(ttlRow.row);
  rightCol.add(maxRow.row);

  let networkChips: ReturnType<typeof buildNetworkChips> | null = null;
  let chainChips:   ReturnType<typeof buildChainChips>   | null = null;
  const initialFamily = familyFromCaip2(prefs.defaultNetwork);
  const initialChain  = prefs.defaultNetwork
    && CHAINS_BY_FAMILY[initialFamily].some(c => c.caip2 === prefs.defaultNetwork)
    ? prefs.defaultNetwork
    : FAMILY_DEFAULT_CAIP2[initialFamily];
  if (!freeMode) {
    rightCol.add(makeSectionHeader(renderer, 'NETWORK'));
    const netRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
    netRow.add(new TextRenderable(renderer, { content: 'Network'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    networkChips = buildNetworkChips(renderer, initialFamily);
    netRow.add(networkChips.row);
    rightCol.add(netRow);

    const chainRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
    chainRow.add(new TextRenderable(renderer, { content: 'Chain'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
    chainChips = buildChainChips(renderer, initialFamily, initialChain);
    chainRow.add(chainChips.row);
    rightCol.add(chainRow);
  }

  const footer = buildFooter(renderer, [
    { key: 'R',    label: 'rescan'       },
    { key: '↑↓',   label: 'navigate'     },
    { key: '↵',    label: 'edit · toggle'},
    { key: '1-5',  label: 'select'       },
    { key: 'M',    label: 'bookmark'     },
    { key: 'T',    label: 'type'         },
    { key: 'S',    label: 'start proxy'  },
    { key: 'B',    label: 'back'         },
  ], 'REVERSE PROXY SETUP');
  root.add(footer.box);
  void footer;

  const defaultListenPort = chooseDefaultPort([], REVERSE_PROXY_PORT_CANDIDATES, 8081);

  const fields: FieldState[] = [
    { id: 'host',       value: 'localhost' },
    { id: 'port',       value: '3000' },
    { id: 'protocol',   value: 'http', options: ['http', 'https'] },
    { id: 'listenPort', value: String(defaultListenPort) },
    { id: 'cacheTtl',   value: String(prefs.defaultCacheTtl || 30) },
    { id: 'maxEntries', value: '1000' },
    { id: 'family',     value: initialFamily, options: ['evm', 'svm', 'icp'] },
    { id: 'chain',      value: initialChain,  options: CHAINS_BY_FAMILY[initialFamily].map(c => c.caip2) },
  ];

  type Section = 'lists' | 'form';
  let section: Section = 'lists';
  let listIdx = 0;
  let formIdx = 0;
  let editing = false;
  let processes: DiscoveredProcess[] = [];
  let bookmarks = loadBookmarks().filter(b => b.type === 'proxy-reverse');
  let cursorOn = true;

  const FORM_FIELD_ORDER: FieldId[] = [
    'host', 'port', 'protocol',
    'listenPort',
    'cacheTtl', 'maxEntries',
    ...(freeMode ? [] as FieldId[] : ['family' as FieldId, 'chain' as FieldId]),
  ];

  const get = (id: FieldId): string => fields.find(f => f.id === id)?.value ?? '';
  const set = (id: FieldId, v: string): void => {
    const f = fields.find(x => x.id === id);
    if (f) f.value = v;
  };

  function renderForm(): void {
    const showCaret = (raw: string, isFocused: boolean): string => {
      if (!isFocused) return raw || ' ';
      return cursorOn ? raw + '█' : raw + ' ';
    };
    const focusedField = section === 'form' ? FORM_FIELD_ORDER[formIdx] : null;
    const refs: Array<[FieldId, ReturnType<typeof makeFieldRow>]> = [
      ['host',       hostRow],
      ['port',       portRow],
      ['listenPort', listenPortRow],
      ['cacheTtl',   ttlRow],
      ['maxEntries', maxRow],
    ];
    for (const [id, ref] of refs) {
      const isFocused = focusedField === id;
      ref.inputBox.borderColor = isFocused ? C.accent : C.line2;
      const raw = get(id);
      ref.inputText.content = raw === '' && !isFocused ? ' ' : showCaret(raw, isFocused && editing);
      ref.inputText.fg      = raw === '' && !isFocused ? C.dim : C.white;
    }
    protoToggle.setActive(get('protocol') === 'https' ? 'b' : 'a');
    if (networkChips) networkChips.setSelected(get('family') as NetworkFamily);
    if (chainChips)   chainChips.setActive(get('chain'));

    crumb.setSection(currentSectionLabel());
  }

  function rerender(): void {
    detected.setProcesses(processes);
    detected.setFocused(section === 'lists' ? listIdx : null);
    bookmarksPanel.setBookmarks(bookmarks);
    renderForm();
  }

  const spin = makeSpin('scan');
  let scanning = false;
  let scanTicker: ReturnType<typeof setInterval> | null = null;
  const rescan = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    detected.rescanLbl.content = `${spin()} scanning…`;
    detected.rescanLbl.fg      = C.amber;
    scanTicker = setInterval(() => {
      detected.rescanLbl.content = `${spin()} scanning…`;
    }, 120);
    try {
      processes = await discoverAll(HTTP_PORTS);
    } catch (e) {
      writeTraceLog('reverseSetup.scan.failed', { err: String(e) });
      processes = [];
    }
    if (scanTicker) { clearInterval(scanTicker); scanTicker = null; }
    detected.rescanLbl.content = 'rescan';
    detected.rescanLbl.fg      = C.slate;
    scanning = false;
    rerender();
  };

  rerender();
  void rescan();

  const blinkTimer = setInterval(() => { cursorOn = !cursorOn; renderForm(); }, 500);

  function collect(): ReverseSetupResult {
    const ttlSec = parseInt(get('cacheTtl') || '0', 10);
    const lp     = parseInt(get('listenPort') || String(defaultListenPort), 10);
    const result: ReverseSetupResult = {
      upstream: {
        host:     get('host')     || 'localhost',
        port:     parseInt(get('port') || '3000', 10),
        protocol: get('protocol') as 'http' | 'https',
      },
      listenPort:    !isNaN(lp) && lp > 0 ? lp : defaultListenPort,
      cacheTtl:      (isNaN(ttlSec) ? 30 : ttlSec) * 1000,
      cacheMaxSize:  parseInt(get('maxEntries') || '1000', 10),
    };
    if (!freeMode) {
      const chain = get('chain');
      if (chain) result.preferNetwork = chain as PreferNetwork;
    }
    return result;
  }

  function selectProcess(idx: number): void {
    const p = processes[idx];
    if (!p) return;
    listIdx = idx;
    set('host', 'localhost');
    set('port', String(p.port));
    rerender();
  }

  function saveCurrent(): void {
    const port = parseInt(get('port'), 10);
    if (!port) return;
    const bm: Bookmark = {
      id:        crypto.randomUUID(),
      label:     `${get('host') || 'localhost'}:${port}`,
      type:      'proxy-reverse',
      target:    `${get('host') || 'localhost'}:${port}`,
      port,
      cacheTtl:  parseInt(get('cacheTtl'), 10) || undefined,
      createdAt: Date.now(),
    };
    try { saveBookmark(bm); } catch { /* non-fatal */ }
    bookmarks = loadBookmarks().filter(b => b.type === 'proxy-reverse');
    rerender();
  }

  function loadBookmark(idx: number): void {
    const bm = bookmarks[idx];
    if (!bm) return;
    const [host, portStr] = bm.target.split(':') as [string, string | undefined];
    if (host) set('host', host);
    if (portStr) set('port', portStr);
    else if (bm.port) set('port', String(bm.port));
    if (bm.cacheTtl) set('cacheTtl', String(bm.cacheTtl));
    rerender();
  }

  function onFamilyChanged(): void {
    if (!chainChips) return;
    const fam = get('family') as NetworkFamily;
    const newChain = FAMILY_DEFAULT_CAIP2[fam];
    set('chain', newChain);
    const chainField = fields.find(f => f.id === 'chain');
    if (chainField) chainField.options = CHAINS_BY_FAMILY[fam].map(c => c.caip2);
    chainChips.setFamily(fam, newChain);
  }

  function currentSectionLabel(): string {
    if (section !== 'form') return '';
    const id = FORM_FIELD_ORDER[formIdx]!;
    return FIELD_SECTION[id];
  }

  function teardown(): void {
    clearInterval(blinkTimer);
    if (scanTicker) clearInterval(scanTicker);
    renderer.destroy();
  }

  return new Promise<ReverseSetupOutcome>((resolve) => {
    const done = (outcome: ReverseSetupOutcome): void => {
      teardown();
      resolve(outcome);
    };

    renderer.keyInput.on('keypress', (key) => {
      if (editing) {
        if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
          editing = false; renderForm(); return;
        }
        if (key.name === 'backspace') {
          const id = FORM_FIELD_ORDER[formIdx]!;
          set(id, get(id).slice(0, -1));
          renderForm(); return;
        }
        const ch = key.sequence;
        if (typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch <= '~') {
          const id = FORM_FIELD_ORDER[formIdx]!;
          set(id, get(id) + ch);
          renderForm();
        }
        return;
      }

      if (key.ctrl && key.name === 'c') { done({ kind: 'cancel' }); return; }
      if (key.name === 'b' || key.name === 'B' || key.name === 'escape') { done({ kind: 'cancel' }); return; }
      if (key.name === 's' || key.name === 'S') { done({ kind: 'result', data: collect() }); return; }
      if (key.name === 't' || key.name === 'T') { done({ kind: 'swap-to-forward' }); return; }

      if (key.name === 'm' || key.name === 'M') { saveCurrent(); return; }
      const SHIFTED_DIGIT: Record<string, number> = { '!': 0, '@': 1, '#': 2, '$': 3, '%': 4 };
      if (key.shift && key.name && /^[1-5]$/.test(key.name)) {
        loadBookmark(parseInt(key.name, 10) - 1);
        return;
      }
      if (key.sequence && key.sequence in SHIFTED_DIGIT) {
        loadBookmark(SHIFTED_DIGIT[key.sequence]!);
        return;
      }
      if (key.name && /^[1-5]$/.test(key.name) && !key.shift) {
        selectProcess(parseInt(key.name, 10) - 1);
        return;
      }
      if (key.name === 'r' || key.name === 'R') { void rescan(); return; }
      if (key.name === 'tab') {
        section = section === 'lists' ? 'form' : 'lists';
        rerender();
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        if (section === 'lists') listIdx = Math.max(0, listIdx - 1);
        else                     formIdx = Math.max(0, formIdx - 1);
        rerender(); return;
      }
      if (key.name === 'down' || key.name === 'j') {
        if (section === 'lists') listIdx = Math.min(processes.length - 1, listIdx + 1);
        else                     formIdx = Math.min(FORM_FIELD_ORDER.length - 1, formIdx + 1);
        rerender(); return;
      }
      if (section === 'form' && (key.name === 'return' || key.name === 'enter')) {
        const id = FORM_FIELD_ORDER[formIdx]!;
        const f  = fields.find(x => x.id === id)!;
        if (f.options) {
          const i = f.options.indexOf(f.value);
          f.value = f.options[(i + 1) % f.options.length]!;
          if (id === 'family') onFamilyChanged();
          renderForm();
        } else {
          editing = true;
          renderForm();
        }
        return;
      }
      if (section === 'form' && (key.name === 'left' || key.name === 'right')) {
        const id = FORM_FIELD_ORDER[formIdx]!;
        const f  = fields.find(x => x.id === id)!;
        if (!f.options) return;
        const i  = f.options.indexOf(f.value);
        const di = key.name === 'left' ? -1 : 1;
        f.value  = f.options[(i + di + f.options.length) % f.options.length]!;
        if (id === 'family') onFamilyChanged();
        renderForm();
        return;
      }
      if (section === 'lists' && (key.name === 'return' || key.name === 'enter')) {
        selectProcess(listIdx);
        return;
      }
    });
  });
}

void Array<FooterHint>;
