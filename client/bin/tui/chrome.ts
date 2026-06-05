import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type RootRenderable,
} from '@opentui/core';
import { C } from '../theme';
import { loadPrefs } from '../lib/store.ts';
import { loadConfig } from '../lib/config.ts';

export const VERSION = '2.4.1';

export function termCols(min = 96): number {
  return Math.max(min, process.stdout.columns || 168);
}

export function upper(text: string): string {
  return text.toUpperCase();
}

export function balanceUsd(): number {
  return Number(process.env.CONSENSUS_BALANCE_USD ?? 24.18);
}

export function acctLabel(): string {
  const prefs = loadPrefs();
  const cfg = loadConfig();
  return prefs.displayName
    || cfg.wallet_name
    || (cfg.addresses?.evm ? `${cfg.addresses.evm.slice(0, 6)}…${cfg.addresses.evm.slice(-4)}` : 'guest');
}

export function shortMiddle(value: string | undefined, front = 6, back = 4): string {
  if (!value) return '—';
  if (value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

export type Badge = { box: BoxRenderable; label: TextRenderable };

export function makeBadge(
  renderer: CliRenderer,
  text: string,
  opts: { bg?: string; fg?: string } = {},
): Badge {
  const bg = opts.bg ?? C.line2;
  const box = new BoxRenderable(renderer, { flexDirection: 'row', paddingX: 1, backgroundColor: bg });
  const label = new TextRenderable(renderer, {
    content: text, fg: opts.fg ?? C.dark, bg, attributes: TextAttributes.BOLD,
  });
  box.add(label);
  return { box, label };
}

export function hintPair(
  renderer: CliRenderer,
  key: string,
  label: string,
  bg = C.panel,
  badgeBg = C.line2,
): { box: BoxRenderable; badge: Badge; label: TextRenderable } {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, alignItems: 'center', backgroundColor: bg,
  });
  const badge = makeBadge(renderer, key, { bg: badgeBg });
  const text = new TextRenderable(renderer, { content: label, fg: C.slate, bg });
  box.add(badge.box);
  box.add(text);
  return { box, badge, label: text };
}

export type TopBar = { box: BoxRenderable; status: TextRenderable; setStatus(text: string, color: string): void };

export function makeTopBar(
  renderer: CliRenderer,
  root: RootRenderable,
  opts: { freeMode?: boolean; status?: string; statusColor?: string } = {},
): TopBar {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingX: 2, paddingY: 0,
    border: ['bottom'], borderColor: C.line2, backgroundColor: C.dark,
  });
  const brand = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.dark });
  brand.add(new TextRenderable(renderer, {
    content: '▲ CONSENSUS', fg: C.white, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  brand.add(new TextRenderable(renderer, {
    content: 'your private network, on demand', fg: C.dim, bg: C.dark,
  }));

  const right = new BoxRenderable(renderer, { flexDirection: 'row', gap: 3, backgroundColor: C.dark });
  const status = new TextRenderable(renderer, {
    content: opts.status ?? '● connected', fg: opts.statusColor ?? C.emerald, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  right.add(status);
  right.add(new TextRenderable(renderer, {
    content: `acct ${acctLabel()}`, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  right.add(new TextRenderable(renderer, {
    content: opts.freeMode ? 'tier free' : `bal $${balanceUsd().toFixed(2)}`,
    fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));
  right.add(new TextRenderable(renderer, {
    content: `v ${VERSION}`, fg: C.slate, bg: C.dark, attributes: TextAttributes.BOLD,
  }));

  box.add(brand);
  box.add(right);
  root.add(box);
  return {
    box, status,
    setStatus(text: string, color: string) { status.content = text; status.fg = color; },
  };
}

export type KeyHint = { key: string; label: string; badgeBg?: string };
export type KeyBar = {
  box: BoxRenderable;
  right: TextRenderable;
  chips: Map<string, { box: BoxRenderable; badge: Badge; label: TextRenderable }>;
};

export function makeKeyBar(renderer: CliRenderer, hints: KeyHint[], rightLabel: string): KeyBar {
  const box = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0,
    border: ['top'], borderColor: C.line2, backgroundColor: C.panel,
  });
  const chipRow = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, backgroundColor: C.panel });
  const chips = new Map<string, { box: BoxRenderable; badge: Badge; label: TextRenderable }>();
  for (const h of hints) {
    const pair = hintPair(renderer, h.key, h.label, C.panel, h.badgeBg ?? C.line2);
    chipRow.add(pair.box);
    chips.set(h.key, pair);
  }
  const right = new TextRenderable(renderer, {
    content: rightLabel, fg: C.dim, bg: C.panel, attributes: TextAttributes.BOLD,
  });
  box.add(chipRow);
  box.add(right);
  return { box, right, chips };
}
