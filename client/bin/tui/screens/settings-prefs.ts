import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from '@opentui/core';
import { C } from '../../theme';
import { termCols, upper } from '../chrome.ts';
import { savePrefs, type Preferences } from '../../lib/store.ts';

type FieldKind = 'text' | 'toggle';

export type PrefFieldId =
  | 'displayName' | 'theme'
  | 'defaultProxyPort' | 'defaultCacheTtl' | 'defaultBudget' | 'defaultVerbose'
  | 'defaultRegion' | 'defaultNetwork' | 'defaultExcludeNode'
  | 'defaultProtocol' | 'defaultTarget'
  | 'defaultWsModel' | 'defaultWsMinutes' | 'defaultWsMegabytes';

export type FieldRefs = {
  row: BoxRenderable;
  label: TextRenderable;
  inputBox: BoxRenderable;
  value: TextRenderable;
  suffix?: TextRenderable;
};

export type PrefField = {
  id: PrefFieldId;
  label: string;
  kind: FieldKind;
  value: string;
  options?: string[];
  hint: string;
  refs?: FieldRefs;
  section: 'identity' | 'proxy' | 'tunnel' | 'websocket';
};

function networkPrefToOption(caip2: string | undefined): string {
  return caip2?.startsWith('solana:') ? 'Solana' : 'Base';
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
    width: '100%', flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(opts.labelWidth ?? 15), height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const inputBox = new BoxRenderable(renderer, {
    width: opts.width ?? 22, flexDirection: 'row', paddingX: 1,
    border: true, borderStyle: 'rounded', borderColor: C.line2, backgroundColor: C.panel,
  });
  const value = new TextRenderable(renderer, {
    content: field.value || ' ', height: 1, fg: field.value ? C.slate : C.dim, bg: C.panel, attributes: TextAttributes.BOLD,
  });
  inputBox.add(value);
  row.add(labelRef);
  row.add(inputBox);
  let suffixRef: TextRenderable | undefined;
  if (opts.suffix) {
    suffixRef = new TextRenderable(renderer, {
      content: opts.suffix, height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
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
    width: '100%', flexDirection: 'row', gap: 2, alignItems: 'center', backgroundColor: C.dark,
  });
  const labelRef = new TextRenderable(renderer, {
    content: label.padEnd(opts.labelWidth ?? 15), height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  });
  const inputBox = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: C.dark,
  });
  const value = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
  inputBox.add(value);
  row.add(labelRef);
  row.add(inputBox);
  let suffixRef: TextRenderable | undefined;
  if (opts.suffix) {
    suffixRef = new TextRenderable(renderer, {
      content: opts.suffix, height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
    });
    row.add(suffixRef);
  }
  parent.add(row);
  return { row, label: labelRef, inputBox, value, suffix: suffixRef };
}

function makeSectionHeader(renderer: CliRenderer, parent: BoxRenderable, title: string, innerWidth: number): void {
  const row = new BoxRenderable(renderer, {
    width: '100%', height: 1, flexDirection: 'row', gap: 1, backgroundColor: C.dark,
  });
  row.add(new TextRenderable(renderer, {
    content: upper(title), height: 1, fg: C.dim, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  row.add(new TextRenderable(renderer, {
    content: '─'.repeat(Math.max(8, innerWidth - title.length - 2)), height: 1, fg: C.line2, bg: C.dark,
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
    width: '100%', flexDirection: 'row', gap: 4, alignItems: 'center', backgroundColor: C.dark,
  });
  const left = new BoxRenderable(renderer, { width: leftWidth, flexDirection: 'column', backgroundColor: C.dark });
  const right = new BoxRenderable(renderer, { width: rightWidth, flexDirection: 'column', backgroundColor: C.dark });
  row.add(left);
  row.add(right);
  parent.add(row);
  return { left, right };
}

export function makePrefsPane(renderer: CliRenderer, fields: PrefField[]): { pane: BoxRenderable; hint: TextRenderable } {
  const contentWidth = Math.max(88, termCols() - 8);
  const panelInner = contentWidth - 4;
  const leftWidth = Math.max(42, Math.floor((panelInner - 4) / 2));
  const rightWidth = Math.max(42, panelInner - leftWidth - 4);
  const pane = new BoxRenderable(renderer, {
    id: 'settings-prefs-pane', width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });

  const panel = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column', paddingX: 2, paddingY: 1,
    border: true, borderStyle: 'single', borderColor: C.line2, title: ' DEFAULTS ', backgroundColor: C.dark,
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
    width: '100%', height: 3, flexDirection: 'row', paddingX: 2, marginTop: 1,
    border: true, borderStyle: 'single', borderColor: C.line2, backgroundColor: C.panel,
  });
  const hint = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel, attributes: TextAttributes.BOLD });
  hintBox.add(hint);
  pane.add(hintBox);
  return { pane, hint };
}

export function prefFieldsFromPrefs(prefs: Preferences): PrefField[] {
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

export function persistField(field: PrefField): void {
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
    const chip = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: bg });
    chip.add(new TextRenderable(renderer, {
      content: opt, height: 1, fg: active ? C.dark : C.slate, bg, attributes: TextAttributes.BOLD,
    }));
    refs.inputBox.add(chip);
  }
}

export function renderPrefFields(
  renderer: CliRenderer,
  fields: PrefField[],
  cursor: number,
  editBuf: string | null,
  hint: TextRenderable,
): void {
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
