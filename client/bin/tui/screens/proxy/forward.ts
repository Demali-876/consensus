/**
 * Forward proxy setup — v2 design.
 *
 * Returns either a ForwardSetupResult (Start was pressed), `null` (Back), or
 * the swap sentinel (`{ swap: 'reverse' }`) when the user toggled TYPE.
 *
 * Result-shape parity with the previous version is preserved so index.ts and
 * the dispatchProxy plumbing don't change — only the UI is new.
 */

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../../theme';
import { writeTraceLog } from '../../../lib/crash-log';
import { discoverAll, type DiscoveredProcess } from '../../../lib/discover.ts';
import { HTTP_PORTS } from '../../../lib/ports.ts';
import { makeSpin } from '../../../lib/spinners.ts';
import { loadPrefs, loadBookmarks, saveBookmark, type Bookmark } from '../../../lib/store.ts';
import { isFreeMode } from '../../../lib/server-config';
import type { PreferNetwork } from '../../../../src/payment-fetch.js';
import {
  buildTopBar, buildBreadcrumb, buildSubtitle,
  buildDetectedPanel, buildBookmarksPanel, buildWalletPanel,
  buildNetworkChips, buildChainChips, buildFooter,
  makeFieldRow, makeSectionHeader, makeToggle, makeBadge,
  familyFromCaip2, FAMILY_DEFAULT_CAIP2, CHAINS_BY_FAMILY,
  type FooterHint, type NetworkFamily,
} from './setup-common.ts';
import crypto from 'node:crypto';

export type ForwardSetupResult = {
  appPort?:        number;
  appEntry?:       string;
  appCheckPath?:   string;
  autoLaunch?:     boolean;
  nodeRegion?:     string;
  nodeDomain?:     string;
  nodeExclude?:    string;
  routes?:         string[];
  mode?:           'inclusive' | 'exclusive';
  matchSubroutes?: boolean;
  cacheTtl?:       number;
  verbose?:        boolean;
  budget?:         number;
  preferNetwork?:  PreferNetwork;
};

/** Discriminated outcome — lets index.ts route on `swap` without affecting the result type. */
export type ForwardSetupOutcome =
  | { kind: 'result'; data: ForwardSetupResult }
  | { kind: 'cancel' }
  | { kind: 'swap-to-reverse' };

// Back-compat alias: existing callers using `await showForwardSetup()` get the
// unwrapped result for kind:'result', null for cancel, and `{ swap: 'reverse' }`
// for the type-toggle.
export type ForwardSetupReturn = ForwardSetupResult | null | { swap: 'reverse' };

export async function showForwardSetup(): Promise<ForwardSetupReturn> {
  const outcome = await showForwardSetupInternal();
  if (outcome.kind === 'result')          return outcome.data;
  if (outcome.kind === 'swap-to-reverse') return { swap: 'reverse' };
  return null;
}

// ─── Editable field schema ───────────────────────────────────────────────────

type FieldId =
  | 'appPort' | 'appEntry' | 'appCheckPath' | 'autoLaunch'
  | 'nodeRegion' | 'nodeDomain' | 'nodeExclude'
  | 'routes' | 'mode' | 'matchSubroutes'
  | 'cacheTtl' | 'verbose'
  | 'budget' | 'family' | 'chain';

/** Which top-level section the field belongs to — drives the section indicator. */
type FieldSection = 'APP' | 'NODE' | 'ROUTING' | 'PERFORMANCE' | 'BUDGET' | 'NETWORK';
const FIELD_SECTION: Record<FieldId, FieldSection> = {
  appPort:        'APP',
  appEntry:       'APP',
  appCheckPath:   'APP',
  autoLaunch:     'APP',
  nodeRegion:     'NODE',
  nodeDomain:     'NODE',
  nodeExclude:    'NODE',
  routes:         'ROUTING',
  mode:           'ROUTING',
  matchSubroutes: 'ROUTING',
  cacheTtl:       'PERFORMANCE',
  verbose:        'PERFORMANCE',
  budget:         'BUDGET',
  family:         'NETWORK',
  chain:          'NETWORK',
};

interface FieldState {
  id:      FieldId;
  value:   string;
  options?: string[];          // for toggle fields
}

async function showForwardSetupInternal(): Promise<ForwardSetupOutcome> {
  const prefs    = loadPrefs();
  const version  = '0.1.0-beta.7';
  const freeMode = await isFreeMode();

  // ─── Renderer + root ───────────────────────────────────────────────────────
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  // ─── Top bar + breadcrumb + subtitle ──────────────────────────────────────
  root.add(buildTopBar(renderer, { version, freeMode }));
  const crumb = buildBreadcrumb(renderer, 'forward');
  root.add(crumb.row);
  root.add(buildSubtitle(renderer, "route your app's outbound traffic through a paid Consensus node"));

  // ─── Body: two-column ──────────────────────────────────────────────────────
  const body = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    paddingX: 2, backgroundColor: C.dark,
  });
  root.add(body);

  // ── Left column ──────────────────────────────────────────────────────────
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

  // ── Right column ─────────────────────────────────────────────────────────
  const rightCol = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column', gap: 1, backgroundColor: C.dark,
  });
  body.add(rightCol);

  // APP section
  rightCol.add(makeSectionHeader(renderer, 'APP'));
  const appPortRow      = makeFieldRow(renderer, 'App port',     'port your server listens on', { inputWidth: 12 });
  const appEntryRow     = makeFieldRow(renderer, 'Entry file',   '[space] browse');
  const appCheckRow     = makeFieldRow(renderer, 'Check path',   'returns 2xx when healthy');
  const autoLaunchRow   = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  autoLaunchRow.add(new TextRenderable(renderer, { content: 'Auto relaunch '.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const autoLaunchToggle = makeToggle(renderer, 'off', 'on', 'a');
  autoLaunchRow.add(autoLaunchToggle.row);
  autoLaunchRow.add(new TextRenderable(renderer, { content: 'restart app with Consensus preload', fg: C.dim, bg: C.dark }));
  rightCol.add(appPortRow.row);
  rightCol.add(appEntryRow.row);
  rightCol.add(appCheckRow.row);
  rightCol.add(autoLaunchRow);

  // NODE section
  rightCol.add(makeSectionHeader(renderer, 'NODE'));
  const regionRow  = makeFieldRow(renderer, 'Region',  'blank = auto');
  const domainRow  = makeFieldRow(renderer, 'Domain',  '', { placeholder: 'pin a specific node domain' });
  const excludeRow = makeFieldRow(renderer, 'Exclude', '', { placeholder: 'skip this node domain' });
  rightCol.add(regionRow.row);
  rightCol.add(domainRow.row);
  rightCol.add(excludeRow.row);

  // ROUTING + PERFORMANCE side-by-side (when there's room) — for now stack
  // vertically since each row is full-width. Keeps the layout consistent
  // across narrow terminals.
  rightCol.add(makeSectionHeader(renderer, 'ROUTING'));
  const routesRow = makeFieldRow(renderer, 'Routes', '', { placeholder: '/api, /v2' });
  rightCol.add(routesRow.row);

  const modeRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  modeRow.add(new TextRenderable(renderer, { content: 'Mode'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const modeToggle = makeToggle(renderer, 'inclusive', 'exclusive', 'a');
  modeRow.add(modeToggle.row);
  rightCol.add(modeRow);

  const matchRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  matchRow.add(new TextRenderable(renderer, { content: 'Match subroutes'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const matchToggle = makeToggle(renderer, 'off', 'on', 'b');
  matchRow.add(matchToggle.row);
  rightCol.add(matchRow);

  rightCol.add(makeSectionHeader(renderer, 'PERFORMANCE'));
  const ttlRow = makeFieldRow(renderer, 'Cache TTL', 'sec · 0 = off', { inputWidth: 12 });
  rightCol.add(ttlRow.row);
  const verboseRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark });
  verboseRow.add(new TextRenderable(renderer, { content: 'Verbose'.padEnd(14), fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD }));
  const verboseToggle = makeToggle(renderer, 'off', 'on', 'a');
  verboseRow.add(verboseToggle.row);
  verboseRow.add(new TextRenderable(renderer, { content: 'add metadata header', fg: C.dim, bg: C.dark }));
  rightCol.add(verboseRow);

  // BUDGET + NETWORK + CHAIN — only when NOT free mode. Free mode hides
  // them since the proxy never charges and the network is irrelevant.
  let budgetRow:    ReturnType<typeof makeFieldRow> | null = null;
  let networkChips: ReturnType<typeof buildNetworkChips> | null = null;
  let chainChips:   ReturnType<typeof buildChainChips>   | null = null;
  const initialFamily = familyFromCaip2(prefs.defaultNetwork);
  const initialChain  = prefs.defaultNetwork
    && CHAINS_BY_FAMILY[initialFamily].some(c => c.caip2 === prefs.defaultNetwork)
    ? prefs.defaultNetwork
    : FAMILY_DEFAULT_CAIP2[initialFamily];
  if (!freeMode) {
    rightCol.add(makeSectionHeader(renderer, 'BUDGET'));
    budgetRow = makeFieldRow(renderer, 'Spend limit', 'USD / session', { inputWidth: 12 });
    rightCol.add(budgetRow.row);

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

  // ─── Footer chips ──────────────────────────────────────────────────────────
  const footer = buildFooter(renderer, makeFooterHints('lists'), 'FORWARD PROXY SETUP');
  root.add(footer.box);

  // ─── State ─────────────────────────────────────────────────────────────────
  const fields: FieldState[] = [
    { id: 'appPort',        value: '' },
    { id: 'appEntry',       value: '' },
    { id: 'appCheckPath',   value: prefs.defaultTarget ?? '/' },
    { id: 'autoLaunch',     value: 'off', options: ['off', 'on'] },
    { id: 'nodeRegion',     value: prefs.defaultRegion ?? '' },
    { id: 'nodeDomain',     value: '' },
    { id: 'nodeExclude',    value: prefs.defaultExcludeNode ?? '' },
    { id: 'routes',         value: '' },
    { id: 'mode',           value: 'inclusive', options: ['inclusive', 'exclusive'] },
    { id: 'matchSubroutes', value: 'on', options: ['off', 'on'] },
    { id: 'cacheTtl',       value: String(prefs.defaultCacheTtl || 300) },
    { id: 'verbose',        value: prefs.defaultVerbose ? 'on' : 'off', options: ['off', 'on'] },
    { id: 'budget',         value: prefs.defaultBudget != null ? String(prefs.defaultBudget) : '5.00' },
    // `family` is a toggle across EVM/SVM/ICP; `chain` is the specific CAIP-2
    // inside that family. Wire-format payment uses only `chain`.
    { id: 'family',         value: initialFamily, options: ['evm', 'svm', 'icp'] },
    { id: 'chain',          value: initialChain,
                            options: CHAINS_BY_FAMILY[initialFamily].map(c => c.caip2) },
  ];

  type Section = 'lists' | 'form';
  let section: Section = 'lists';
  let listIdx = 0;
  let formIdx = 0;
  let editing = false;
  let processes: DiscoveredProcess[] = [];
  let bookmarks = loadBookmarks().filter(b => b.type === 'proxy-forward');
  let cursorOn = true;

  const get = (id: FieldId): string => fields.find(f => f.id === id)?.value ?? '';
  const set = (id: FieldId, v: string): void => {
    const f = fields.find(x => x.id === id);
    if (f) f.value = v;
  };

  // ─── Render functions ──────────────────────────────────────────────────────
  function renderForm(): void {
    // Update each row's input contents from the backing field value.
    const showCaret = (raw: string, isFocused: boolean): string => {
      if (!isFocused) return raw || ' ';
      return cursorOn ? raw + '█' : raw + ' ';
    };
    const focusedField = section === 'form' ? FORM_FIELD_ORDER[formIdx] : null;

    const refs: Array<[FieldId, ReturnType<typeof makeFieldRow>]> = [
      ['appPort',      appPortRow],
      ['appEntry',     appEntryRow],
      ['appCheckPath', appCheckRow],
      ['nodeRegion',   regionRow],
      ['nodeDomain',   domainRow],
      ['nodeExclude',  excludeRow],
      ['routes',       routesRow],
      ['cacheTtl',     ttlRow],
    ];
    if (budgetRow) refs.push(['budget', budgetRow]);
    for (const [id, ref] of refs) {
      const isFocused = focusedField === id;
      ref.inputBox.borderColor = isFocused ? C.accent : C.line2;
      const raw = get(id);
      ref.inputText.content = raw === '' && !isFocused
        ? ' '                                                     // empty placeholder
        : showCaret(raw, isFocused && editing);
      ref.inputText.fg = raw === '' && !isFocused ? C.dim : C.white;
    }

    // Toggles
    autoLaunchToggle.setActive(get('autoLaunch') === 'on' ? 'b' : 'a');
    modeToggle.setActive      (get('mode')       === 'exclusive' ? 'b' : 'a');
    matchToggle.setActive     (get('matchSubroutes') === 'on' ? 'b' : 'a');
    verboseToggle.setActive   (get('verbose')    === 'on' ? 'b' : 'a');
    if (networkChips) networkChips.setSelected(get('family') as NetworkFamily);
    if (chainChips)   chainChips.setActive(get('chain'));

    // Section indicator updates with focus.
    crumb.setSection(currentSectionLabel());
  }

  function rerender(): void {
    detected.setProcesses(processes);
    detected.setFocused(section === 'lists' ? listIdx : null);
    bookmarksPanel.setBookmarks(bookmarks);
    renderForm();
  }

  // ─── Initial scan ──────────────────────────────────────────────────────────
  const spin      = makeSpin('scan');
  let scanning    = false;
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
      writeTraceLog('forwardSetup.scan.failed', { err: String(e) });
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

  // Blink tick for caret
  const blinkTimer = setInterval(() => { cursorOn = !cursorOn; renderForm(); }, 500);

  // ─── Field order for arrow nav (skips budget/network if free mode) ────────
  const FORM_FIELD_ORDER: FieldId[] = [
    'appPort', 'appEntry', 'appCheckPath', 'autoLaunch',
    'nodeRegion', 'nodeDomain', 'nodeExclude',
    'routes', 'mode', 'matchSubroutes',
    'cacheTtl', 'verbose',
    ...(freeMode ? [] as FieldId[] : ['budget' as FieldId, 'family' as FieldId, 'chain' as FieldId]),
  ];

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function collect(): ForwardSetupResult {
    const out: ForwardSetupResult = {};
    const ap = parseInt(get('appPort'), 10);   if (!isNaN(ap) && ap > 0) out.appPort = ap;
    const ae = get('appEntry').trim();         if (ae) out.appEntry = ae;
    const cp = get('appCheckPath').trim();     if (cp) out.appCheckPath = cp;
    if (get('autoLaunch') === 'on') out.autoLaunch = true;
    const nr = get('nodeRegion').trim();       if (nr) out.nodeRegion = nr;
    const nd = get('nodeDomain').trim();       if (nd) out.nodeDomain = nd;
    const ne = get('nodeExclude').trim();      if (ne) out.nodeExclude = ne;
    const rs = get('routes').split(',').map(s => s.trim()).filter(Boolean);
    if (rs.length) out.routes = rs;
    if (get('mode') === 'exclusive') out.mode = 'exclusive';
    else                              out.mode = 'inclusive';
    if (get('matchSubroutes') === 'on') out.matchSubroutes = true;
    const ttl = parseInt(get('cacheTtl'), 10); if (!isNaN(ttl) && ttl >= 0) out.cacheTtl = ttl;
    if (get('verbose') === 'on') out.verbose = true;
    if (!freeMode) {
      const b = parseFloat(get('budget'));      if (!isNaN(b) && b > 0) out.budget = b;
      const chain = get('chain');               // already a CAIP-2
      if (chain) out.preferNetwork = chain as PreferNetwork;
    }
    return out;
  }

  function selectProcess(idx: number): void {
    const p = processes[idx];
    if (!p) return;
    listIdx = idx;
    set('appPort',  String(p.port));
    if (p.entryFile) set('appEntry', p.entryFile);
    rerender();
  }

  function saveCurrent(): void {
    const port = parseInt(get('appPort'), 10);
    if (!port) return;
    const bm: Bookmark = {
      id:        crypto.randomUUID(),
      label:     `port ${port}${get('nodeRegion') ? ' · ' + get('nodeRegion') : ''}`,
      type:      'proxy-forward',
      target:    `localhost:${port}`,
      port,
      region:    get('nodeRegion') || undefined,
      cacheTtl:  parseInt(get('cacheTtl'), 10) || undefined,
      budget:    !freeMode ? parseFloat(get('budget')) || undefined : undefined,
      createdAt: Date.now(),
    };
    try { saveBookmark(bm); } catch { /* non-fatal */ }
    bookmarks = loadBookmarks().filter(b => b.type === 'proxy-forward');
    rerender();
  }

  function loadBookmark(idx: number): void {
    const bm = bookmarks[idx];
    if (!bm) return;
    if (bm.port) set('appPort', String(bm.port));
    if (bm.region) set('nodeRegion', bm.region);
    if (bm.cacheTtl) set('cacheTtl', String(bm.cacheTtl));
    if (bm.budget && !freeMode) set('budget', String(bm.budget));
    rerender();
  }

  /**
   * Called when the `family` chip changes. Rebuilds the underlying chain
   * options so ←/→/Enter on the chain field cycles within the new family,
   * and snaps `chain` to that family's default.
   */
  function onFamilyChanged(): void {
    if (!chainChips) return;
    const fam = get('family') as NetworkFamily;
    const newChain = FAMILY_DEFAULT_CAIP2[fam];
    set('chain', newChain);
    const chainField = fields.find(f => f.id === 'chain');
    if (chainField) chainField.options = CHAINS_BY_FAMILY[fam].map(c => c.caip2);
    chainChips.setFamily(fam, newChain);
  }

  /** Section indicator — shown in the breadcrumb when section === 'form'. */
  function currentSectionLabel(): string {
    if (section !== 'form') return '';
    const id  = FORM_FIELD_ORDER[formIdx]!;
    return FIELD_SECTION[id];
  }

  function teardown(): void {
    clearInterval(blinkTimer);
    if (scanTicker) clearInterval(scanTicker);
    renderer.destroy();
  }

  // ─── Key input ─────────────────────────────────────────────────────────────
  return new Promise<ForwardSetupOutcome>((resolve) => {
    const done = (outcome: ForwardSetupOutcome): void => {
      teardown();
      resolve(outcome);
    };

    renderer.keyInput.on('keypress', (key) => {
      // ── Text edit mode ──────────────────────────────────────────────────
      if (editing) {
        if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
          editing = false;
          renderForm();
          return;
        }
        if (key.name === 'backspace') {
          const id = FORM_FIELD_ORDER[formIdx]!;
          set(id, get(id).slice(0, -1));
          renderForm();
          return;
        }
        const ch = key.sequence;
        if (typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch <= '~') {
          const id = FORM_FIELD_ORDER[formIdx]!;
          set(id, get(id) + ch);
          renderForm();
        }
        return;
      }

      // ── Global ──────────────────────────────────────────────────────────
      if (key.ctrl && key.name === 'c') { done({ kind: 'cancel' }); return; }
      if (key.name === 'b' || key.name === 'B' || key.name === 'escape') {
        done({ kind: 'cancel' });
        return;
      }
      if (key.name === 's' || key.name === 'S') {
        done({ kind: 'result', data: collect() });
        return;
      }
      // TYPE swap
      if (key.name === 't' || key.name === 'T') {
        done({ kind: 'swap-to-reverse' });
        return;
      }

      // Bookmark save: M
      if (key.name === 'm' || key.name === 'M') {
        saveCurrent();
        return;
      }
      // Bookmark load: Shift+1..5
      const SHIFTED_DIGIT: Record<string, number> = { '!': 0, '@': 1, '#': 2, '$': 3, '%': 4 };
      if (key.shift && key.name && /^[1-5]$/.test(key.name)) {
        loadBookmark(parseInt(key.name, 10) - 1);
        return;
      }
      if (key.sequence && key.sequence in SHIFTED_DIGIT) {
        loadBookmark(SHIFTED_DIGIT[key.sequence]!);
        return;
      }

      // Number keys: select process from DETECTED list
      if (key.name && /^[1-5]$/.test(key.name) && !key.shift) {
        selectProcess(parseInt(key.name, 10) - 1);
        return;
      }

      // Rescan
      if (key.name === 'r' || key.name === 'R') { void rescan(); return; }

      // Section nav (Tab)
      if (key.name === 'tab') {
        section = section === 'lists' ? 'form' : 'lists';
        rerender();
        return;
      }

      // List/form navigation
      if (key.name === 'up' || key.name === 'k') {
        if (section === 'lists') listIdx = Math.max(0, listIdx - 1);
        else                     formIdx = Math.max(0, formIdx - 1);
        rerender();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        if (section === 'lists') {
          listIdx = Math.min(processes.length - 1, listIdx + 1);
        } else {
          formIdx = Math.min(FORM_FIELD_ORDER.length - 1, formIdx + 1);
        }
        rerender();
        return;
      }

      // Edit / toggle on the current form field
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

      // List-mode Enter → use selected process as app
      if (section === 'lists' && (key.name === 'return' || key.name === 'enter')) {
        selectProcess(listIdx);
        return;
      }
    });
  });
}

// ─── Footer hints ────────────────────────────────────────────────────────────

function makeFooterHints(_section: 'lists' | 'form'): FooterHint[] {
  return [
    { key: 'R',    label: 'rescan'       },
    { key: '↑↓',   label: 'navigate'     },
    { key: '↵',    label: 'edit · toggle'},
    { key: '1-5',  label: 'select'       },
    { key: 'M',    label: 'bookmark'     },
    { key: 'T',    label: 'type'         },
    { key: 'S',    label: 'start proxy'  },
    { key: 'B',    label: 'back'         },
  ];
}

// Suppress unused-var warning on imports the type-only code-paths need
void makeBadge;
