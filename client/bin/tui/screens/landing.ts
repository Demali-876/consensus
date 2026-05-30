import { readFile } from 'fs/promises';
import * as path from 'node:path';
import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  FrameBufferRenderable,
  RGBA,
} from '@opentui/core';
import figlet, { type FontName } from 'figlet';
import { decode as decodeBmp } from 'bmp-ts';
import * as fs from 'node:fs';
import { C, isDark } from '../../theme';
import { isFreeMode } from '../../lib/server-config';
import {
  loadConfig, loadPrefs, savePrefs,
  saveSession, loadSessions,
  type SessionRecord, type SessionType,
} from '../../lib/store';
import { openUrl, DOCS_URL } from '../../lib/open-url';
import { showPalette, type PaletteCommand } from './palette';
import { showTour } from './tour';
import { buildActiveBody, type ActiveDashboard } from './landing-active';
import { computeSnapshot } from '../../lib/dashboard-state';
import { workerRegistry } from './proxy/hub';

const BANNER_FONT: FontName = 'Pagga';

const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function makeBitmap(
  renderer: CliRenderer,
  bmpPath: string,
  opts: {
    cols:          number;
    bg:            string;
    /** 'braille' (default) = 2×4 sub-pixels per cell, monochrome — best for
     *  logos / line art. 'half-block' = 2 sub-pixels per cell, full colour
     *  — best for photos. */
    mode?:         'braille' | 'half-block';
    /** Monochrome fg used in braille mode. Defaults to C.white. */
    fg?:           string;
    transparent?:  'auto' | string | false;   // default 'auto'
    keyTolerance?: number;                    // 0-255 per channel, default 12
  },
): FrameBufferRenderable {
  const img  = decodeBmp(fs.readFileSync(bmpPath), { toRGBA: true });
  const cols = opts.cols;
  const tol  = opts.keyTolerance ?? 12;
  const mode = opts.mode ?? 'braille';
  const subPxPerCellY = mode === 'braille' ? 4 : 2;
  const rows = Math.max(1, Math.round((img.height / img.width) * cols * 0.5));

  const hex = (s: string): [number, number, number] => {
    const h = s.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  const [bgR, bgG, bgB] = hex(opts.bg);
  const [fgR, fgG, fgB] = hex(opts.fg ?? C.white);

  let keyR = -1, keyG = -1, keyB = -1;
  const transparent = opts.transparent ?? 'auto';
  if (transparent === 'auto') {
    keyR = img.data[0]!; keyG = img.data[1]!; keyB = img.data[2]!;
  } else if (typeof transparent === 'string') {
    [keyR, keyG, keyB] = hex(transparent);
  }
  const hasKey = keyR >= 0;

  const pxAlpha = (sx: number, sy: number): number => {
    const i = (sy * img.width + sx) * 4;
    const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
    const a = img.data[i + 3]!;
    if (hasKey && Math.abs(r - keyR) <= tol && Math.abs(g - keyG) <= tol && Math.abs(b - keyB) <= tol) {
      return 0;
    }
    return a;
  };
  const pxRgba = (sx: number, sy: number): [number, number, number, number] => {
    const i = (sy * img.width + sx) * 4;
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, pxAlpha(sx, sy)];
  };

  const fb = new FrameBufferRenderable(renderer, { width: cols, height: rows });
  const bgRgba = RGBA.fromValues(bgR / 255, bgG / 255, bgB / 255, 1);

  if (mode === 'braille') {
    // Sub-pixel footprint: 2 horizontal × 4 vertical per cell.
    const subW = img.width  / (cols * 2);
    const subH = img.height / (rows * 4);
    const fgRgba = RGBA.fromValues(fgR / 255, fgG / 255, fgB / 255, 1);

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let mask = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            // Sample the centre of the sub-pixel footprint.
            const sx = Math.min(img.width  - 1, Math.floor((cx * 2 + dx + 0.5) * subW));
            const sy = Math.min(img.height - 1, Math.floor((cy * 4 + dy + 0.5) * subH));
            if (pxAlpha(sx, sy) > 128) mask |= BRAILLE_BIT[dy]![dx]!;
          }
        }
        const ch = mask === 0 ? ' ' : String.fromCodePoint(0x2800 + mask);
        fb.frameBuffer.setCell(cx, cy, ch, fgRgba, bgRgba);
      }
    }
    return fb;
  }

  const cellW = img.width  / cols;
  const cellH = img.height / (rows * subPxPerCellY);

  const area = (x0: number, y0: number, x1: number, y1: number): [number, number, number] => {
    const xs = Math.max(0, Math.floor(x0));
    const ys = Math.max(0, Math.floor(y0));
    const xe = Math.min(img.width,  Math.ceil(x1));
    const ye = Math.min(img.height, Math.ceil(y1));
    let sR = 0, sG = 0, sB = 0, sA = 0, n = 0;
    for (let y = ys; y < ye; y++) {
      for (let x = xs; x < xe; x++) {
        const [r, g, b, a] = pxRgba(x, y);
        const af = a / 255;
        sR += r * af; sG += g * af; sB += b * af;
        sA += af;
        n++;
      }
    }
    if (n === 0) return [bgR, bgG, bgB];
    const coverage = sA / n;
    const avgR = sA > 0 ? sR / sA : 0;
    const avgG = sA > 0 ? sG / sA : 0;
    const avgB = sA > 0 ? sB / sA : 0;
    return [
      Math.round(avgR * coverage + bgR * (1 - coverage)),
      Math.round(avgG * coverage + bgG * (1 - coverage)),
      Math.round(avgB * coverage + bgB * (1 - coverage)),
    ];
  };

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cellW, x1 = (cx + 1) * cellW;
      const top = area(x0, (cy * 2)     * cellH, x1, (cy * 2 + 1) * cellH);
      const bot = area(x0, (cy * 2 + 1) * cellH, x1, (cy * 2 + 2) * cellH);
      fb.frameBuffer.setCell(cx, cy,
        '▀',
        RGBA.fromValues(top[0] / 255, top[1] / 255, top[2] / 255, 1),
        RGBA.fromValues(bot[0] / 255, bot[1] / 255, bot[2] / 255, 1),
      );
    }
  }
  return fb;
}

/**
 * Render a string as multi-row ASCII-art using figlet, returned as a Box
 * containing one TextRenderable per row. All rows share the same fg/bg, so
 * the headline reads as a single typographic block.
 */
function makeBanner(
  renderer: CliRenderer,
  text: string,
  opts: { fg?: string; bg?: string; font?: FontName } = {},
): BoxRenderable {
  const fg = opts.fg ?? C.white;
  const bg = opts.bg ?? C.dark;
  const box = new BoxRenderable(renderer, {
    flexDirection: 'column', backgroundColor: bg,
  });
  const rendered = figlet.textSync(text, { font: opts.font ?? BANNER_FONT });
  for (const line of rendered.split('\n')) {
    if (line.length === 0) continue;
    box.add(new TextRenderable(renderer, { content: line, fg, bg }));
  }
  return box;
}

function makeBadge(
  renderer: CliRenderer,
  text: string,
  opts: { bg: string; fg?: string } = { bg: C.accent },
): { box: BoxRenderable; label: TextRenderable } {
  const fg  = opts.fg ?? C.dark;
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row', paddingX: 1, backgroundColor: opts.bg,
  });
  const label = new TextRenderable(renderer, {
    content:    text,
    fg, bg:     opts.bg,
    attributes: TextAttributes.BOLD,
  });
  box.add(label);
  return { box, label };
}


const SERVER = process.env.CONSENSUS_SERVER_URL ?? 'https://consensus.canister.software';


export function recordSession(session: {
  id: string; type: SessionType; url: string; target: string; startedAt: number;
}): void {
  try {
    saveSession(session as SessionRecord);
  } catch { /* non-fatal */ }
}

export type LandingAction =
  | 'tunnels' | 'proxy' | 'proxy-forward' | 'proxy-reverse'
  | 'websockets' | 'ips' | 'settings' | 'quit';

type Tab = {
  key:    string; 
  label:  string;
  action: LandingAction | 'home';
};

const TABS: Tab[] = [
  { key: '1', label: 'Home',      action: 'home'       },
  { key: '2', label: 'Tunnels',   action: 'tunnels'    },
  { key: '3', label: 'Proxy',     action: 'proxy'      },
  { key: '4', label: 'Nodes',     action: 'ips'        },
  { key: '5', label: 'WebSocket', action: 'websockets' },
  { key: '6', label: 'Settings',  action: 'settings'   },
];

type ServiceCard = {
  key:      string;
  icon:     string;
  title:    string;
  blurb:    string;
  tagId:    'tunnel' | 'proxy' | 'nodes' | 'ws';
  action:   LandingAction;
};

const CARDS: ServiceCard[] = [
  { key: '2', icon: '⇄',  title: 'New tunnel',     blurb: 'expose a local port to a public URL',         tagId: 'tunnel', action: 'tunnels'    },
  { key: '3', icon: '⟳',  title: 'Start proxy',    blurb: 'route outbound traffic through the network',  tagId: 'proxy',  action: 'proxy'      },
  { key: '4', icon: '⬡',  title: 'Lease a node',   blurb: 'grab a dedicated IP from any region',         tagId: 'nodes',  action: 'ips'        },
  { key: '5', icon: '≈',  title: 'Open WebSocket', blurb: 'streaming session with metered spend',        tagId: 'ws',     action: 'websockets' },
];
function clock(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

export async function showLanding(): Promise<LandingAction> {
  const pkg      = await readFile(path.join(import.meta.dir, '../../../package.json'), 'utf8');
  const version  = JSON.parse(pkg).version as string;
  const freeMode = await isFreeMode();
  const prefs    = loadPrefs();
  const config   = loadConfig();
  const acct     = prefs.displayName;
  const hasWallet =
    Boolean(config.wallet_name || config.addresses?.evm || config.addresses?.solana)
    || Boolean(process.env.CONSENSUS_EVM_KEY || process.env.CONSENSUS_SVM_KEY || process.env.CONSENSUS_PEM_PATH);

  // Active-state detector. Returns true when there's *anything* worth showing
  // on a dashboard — in-process proxy workers, any persisted session in the
  // last 5 minutes, or an active node lease. CONSENSUS_FORCE_ACTIVE=1 is a
  // dev-only override so we can preview the active layout without spinning
  // up real services.
  const ACTIVE_LOOKBACK_MS = 5 * 60 * 1000;
  const recentSession = loadSessions().some(s => {
    const ended   = s.endedAt   ?? Number.POSITIVE_INFINITY;
    const started = s.startedAt ?? 0;
    return ended > Date.now() - ACTIVE_LOOKBACK_MS || started > Date.now() - ACTIVE_LOOKBACK_MS;
  });
  const isActive =
       process.env.CONSENSUS_FORCE_ACTIVE === '1'
    || workerRegistry.length > 0
    || recentSession
    || Boolean(config.leased_node);

  const renderer = await createCliRenderer({
    exitOnCtrlC:        false,
    targetFps:          15,
    useMouse:           false,
    useAlternateScreen: true,
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
    content: '▲ CONSENSUS', fg: C.white, bg: C.panel,
    attributes: TextAttributes.BOLD,
  }));
  brandGroup.add(new TextRenderable(renderer, {
    content: 'your private network, on demand', fg: C.dim, bg: C.panel,
  }));
  topBar.add(brandGroup);

  const statusGroup = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 3, backgroundColor: C.panel,
  });
  const connDot   = new TextRenderable(renderer, { content: '○ checking',     fg: C.dim,   bg: C.panel });
  const acctText  = new TextRenderable(renderer, { content: `acct ${acct}`,  fg: C.slate, bg: C.panel });
  const tierText  = new TextRenderable(renderer, { content: `tier ${freeMode ? 'free' : 'paid'}`, fg: C.slate, bg: C.panel });
  const verText   = new TextRenderable(renderer, { content: `v ${version}`,  fg: C.dim,   bg: C.panel });
  statusGroup.add(connDot);
  statusGroup.add(acctText);
  statusGroup.add(tierText);
  statusGroup.add(verText);
  topBar.add(statusGroup);

  root.add(topBar);

  const tabUnderline = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'column',
    paddingX: 2, paddingTop: 1,
    border: ['bottom'], borderStyle: 'single', borderColor: C.line2,
    backgroundColor: C.dark,
  });

  const tabRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2,
    alignItems: 'flex-end',
    backgroundColor: C.dark,
  });

  type TabRefs = {
    cell:      BoxRenderable;
    badgeBox:  BoxRenderable;
    badgeText: TextRenderable;
    label:     TextRenderable;
  };
  const tabRefs: TabRefs[] = [];

  for (const tab of TABS) {
    const cell = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, paddingX: 1, paddingY: 0,
      border:      ['top', 'left', 'right'],
      borderColor: C.line2, borderStyle: 'single',
      backgroundColor: C.dark,
    });

    const { box: badgeBox, label: badgeText } = makeBadge(renderer, tab.key, { bg: C.line2 });
    const label = new TextRenderable(renderer, {
      content: tab.label, fg: C.slate, bg: C.dark,
    });
    cell.add(badgeBox);
    cell.add(label);
    tabRow.add(cell);
    tabRefs.push({ cell, badgeBox, badgeText, label });
  }
  tabUnderline.add(tabRow);
  root.add(tabUnderline);

  const body = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    gap: 1, paddingX: 2, paddingTop: 1, paddingBottom: 0,
    backgroundColor: C.dark,
  });
  root.add(body);

  // ── Refs shared with downstream consumers ────────────────────────────────
  // Hoisted so updateClock/doRefresh/key handlers can reference them whether
  // or not the empty-state body actually built them. When `isActive` is true
  // the empty-state widgets are skipped and these stay at their defaults.
  type CardRefs = {
    box:       BoxRenderable;
    badgeBox:  BoxRenderable;
    badgeText: TextRenderable;
    icon:      TextRenderable;
    title:     TextRenderable;
    blurb:     TextRenderable;
    tag:       TextRenderable;
  };
  const cardRefs: CardRefs[] = [];
  let activityClock: TextRenderable | null = null;
  let dashboard: ActiveDashboard | null = null;
  let serviceIdx = 0;

  if (isActive) {
    dashboard = buildActiveBody(renderer, body, computeSnapshot());
  } else {

  const hero = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 1, paddingBottom: 1,
    backgroundColor: C.dark,
  });

  const heroText = new BoxRenderable(renderer, {
    flexDirection: 'column', backgroundColor: C.dark,
  });
  const acctUpper = prefs.displayName.toUpperCase();

  // Eyebrow — small caps, dim, BOLD for slight weight.
  heroText.add(new TextRenderable(renderer, {
    content: `WELCOME BACK, ${acctUpper}`,
    fg: C.dim, bg: C.dark,
    attributes: TextAttributes.BOLD,
  }));

  // Headline — figlet banner gives the hero clear visual weight above the
  // regular-size subtitle below. See BANNER_FONT at the top of the file.
  heroText.add(makeBanner(renderer, "Nothing's running yet.", {
    fg: C.white, bg: C.dark,
  }));

  heroText.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  heroText.add(new TextRenderable(renderer, {
    content: 'Spin up your first service to start using the network.',
    fg: C.slate, bg: C.dark,
  }));
  heroText.add(new TextRenderable(renderer, {
    content: 'Press a number key, or select a card below.',
    fg: C.slate, bg: C.dark,
  }));

  if (!hasWallet) {
    heroText.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

    const lineA = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center',
      backgroundColor: C.dark,
    });
    lineA.add(makeBadge(renderer, '!', { bg: C.amber }).box);
    lineA.add(new TextRenderable(renderer, {
      content: 'No wallet detected.', fg: C.amber, bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    lineA.add(new TextRenderable(renderer, {
      content: 'Add', fg: C.slate, bg: C.dark,
    }));
    lineA.add(new TextRenderable(renderer, {
      content: 'CONSENSUS_EVM_KEY', fg: C.white, bg: C.panel,
      attributes: TextAttributes.BOLD,
    }));
    lineA.add(new TextRenderable(renderer, {
      content: 'to your environment to connect one.',
      fg: C.slate, bg: C.dark,
    }));
    heroText.add(lineA);

    const lineB = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center',
      backgroundColor: C.dark,
    });
    lineB.add(new TextRenderable(renderer, {
      content: '   Self-managed — your private key never leaves this machine.',
      fg: C.dim, bg: C.dark,
    }));
    lineB.add(new TextRenderable(renderer, {
      content: 'Press', fg: C.dim, bg: C.dark,
    }));
    lineB.add(makeBadge(renderer, 'd', { bg: C.slate }).box);
    lineB.add(new TextRenderable(renderer, {
      content: 'for the setup guide.', fg: C.dim, bg: C.dark,
    }));
    heroText.add(lineB);
  }

  hero.add(heroText);

  const logoPath = path.join(
    import.meta.dir, '../../../assets',
    isDark ? 'logo-light.bmp' : 'logo-dark.bmp',
  );
  hero.add(makeBitmap(renderer, logoPath, {
    cols:        20,
    bg:          C.dark,
    fg:          C.white,
    mode:        'braille',
    transparent: 'auto',
  }));
  body.add(hero);

  // ── Service cards row ─────────────────────────────────────────────────────
  const cardRow = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', gap: 2,
    paddingBottom: 1, backgroundColor: C.dark,
  });

  for (const card of CARDS) {
    const box = new BoxRenderable(renderer, {
      flexGrow: 1, flexShrink: 1, flexDirection: 'column',
      borderStyle: 'single', borderColor: C.line2,
      padding: 1, backgroundColor: C.dark,
    });

    // top row: number badge + icon (space-between)
    const topRow = new BoxRenderable(renderer, {
      width: '100%', flexDirection: 'row', justifyContent: 'space-between',
      backgroundColor: C.dark,
    });
    const { box: badgeBox, label: badgeText } = makeBadge(renderer, card.key, { bg: C.accent });
    const icon = new TextRenderable(renderer, { content: card.icon, fg: C.amber, bg: C.dark });
    topRow.add(badgeBox);
    topRow.add(icon);
    box.add(topRow);
    box.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));

    const title = new TextRenderable(renderer, {
      content: card.title, fg: C.white, bg: C.dark,
      attributes: TextAttributes.BOLD,
    });
    const blurb = new TextRenderable(renderer, { content: card.blurb, fg: C.slate, bg: C.dark });
    box.add(title);
    box.add(blurb);

    box.add(new TextRenderable(renderer, { content: ' ',             fg: C.dim,   bg: C.dark }));
    box.add(new TextRenderable(renderer, { content: '·'.repeat(28), fg: C.line2, bg: C.dark }));

    const tag = new TextRenderable(renderer, { content: '—', fg: C.dim, bg: C.dark });
    box.add(tag);

    cardRow.add(box);
    cardRefs.push({ box, badgeBox, badgeText, icon, title, blurb, tag });
  }

  // initial tag placeholders
  cardRefs[0]!.tag.content = 'localhost → public';
  cardRefs[1]!.tag.content = 'cache · cap · region';
  cardRefs[2]!.tag.content = '— nodes · — regions';
  cardRefs[3]!.tag.content = 'pay-per-message';

  body.add(cardRow);

  // ── Lower row: GETTING STARTED + WAITING FOR ACTIVITY ─────────────────────
  const lower = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'row', gap: 2,
    backgroundColor: C.dark,
  });

  const stepsPanel = new BoxRenderable(renderer, {
    flexGrow: 2, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.emerald,
    title: ' GETTING STARTED ', padding: 1,
    backgroundColor: C.dark,
  });

  const mkStep = (n: string, head: string, tail: string) => {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, backgroundColor: C.dark,
    });
    row.add(new TextRenderable(renderer, { content: n, fg: C.dim, bg: C.dark }));
    row.add(new TextRenderable(renderer, {
      content: head, fg: C.white, bg: C.dark,
      attributes: TextAttributes.BOLD,
    }));
    row.add(new TextRenderable(renderer, { content: tail, fg: C.slate, bg: C.dark }));
    stepsPanel.add(row);
  };
  mkStep('01', 'Pick what to run.', 'Tunnels expose; proxies route; nodes lease IPs.');
  mkStep('02', 'Set a budget.',     freeMode ? 'Free tier covers 1,000 requests/day, no card needed.'
                                             : 'Cap session spend with --budget; track in Settings.');
  mkStep('03', 'Watch this screen.', 'Live metrics & activity appear here once anything runs.');

  lower.add(stepsPanel);

  const activityPanel = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column',
    borderStyle: 'single', borderColor: C.accent,
    title: ' WAITING FOR ACTIVITY ', padding: 1,
    gap: 1,
    backgroundColor: C.dark,
  });

  const activityRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 2, alignItems: 'center',
    backgroundColor: C.dark,
  });
  activityClock = new TextRenderable(renderer, { content: clock(),              fg: C.dim,   bg: C.dark });
  const activitySep   = new TextRenderable(renderer, {
    content: '|', fg: C.accent, bg: C.dark,
    attributes: TextAttributes.BOLD,
  });
  const activityText  = new TextRenderable(renderer, { content: 'listening for events…', fg: C.slate, bg: C.dark });
  activityRow.add(activityClock);
  activityRow.add(activitySep);
  activityRow.add(activityText);
  activityPanel.add(activityRow);

  const mkHint = (k: string, t: string) => {
    const r = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 2, alignItems: 'center',
      backgroundColor: C.dark,
    });
    r.add(makeBadge(renderer, k, { bg: C.slate }).box);
    r.add(new TextRenderable(renderer, { content: t, fg: C.slate, bg: C.dark }));
    activityPanel.add(r);
  };
  mkHint('/', 'open command palette');
  mkHint('?', 'tour the screens');
  mkHint('d', 'open docs');

  lower.add(activityPanel);
  body.add(lower);

  }   // end of `if (!isActive)` empty-state body block

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });

  const hintsGroup = new BoxRenderable(renderer, {
    id: 'footer-hints',
    flexDirection: 'row', gap: 2, alignItems: 'center',
    backgroundColor: C.panel,
  });

  type HintChip = { key: string; label: string };
  const FOOTER_HINTS: HintChip[] = isActive
    ? [
        { key: '↑↓', label: 'navigate'     },
        { key: '↵',  label: 'open service' },
        { key: 'n',  label: 'new'          },
        { key: '/',  label: 'search'       },
        { key: '?',  label: 'help'         },
        { key: 'q',  label: 'quit'         },
      ]
    : [
        { key: '2-5', label: 'start a service' },
        { key: '←→',  label: 'navigate'        },
        { key: '↵',   label: 'open'            },
        { key: 'q',   label: 'quit'            },
      ];
  for (const h of FOOTER_HINTS) {
    const pair = new BoxRenderable(renderer, {
      flexDirection: 'row', gap: 1, alignItems: 'center',
      backgroundColor: C.panel,
    });
    pair.add(makeBadge(renderer, h.key, { bg: C.slate }).box);
    pair.add(new TextRenderable(renderer, { content: h.label, fg: C.slate, bg: C.panel }));
    hintsGroup.add(pair);
  }

  const hintsRef = new TextRenderable(renderer, {
    content: '', fg: C.amber, bg: C.panel,
  });

  const leftFooter = new BoxRenderable(renderer, {
    flexDirection: 'row', backgroundColor: C.panel,
  });
  leftFooter.add(hintsGroup);
  leftFooter.add(hintsRef);

  const stateRef = new TextRenderable(renderer, {
    content: `consensus ${version} · home${isActive ? '' : ' (idle)'}`,
    fg: C.dim, bg: C.panel,
  });
  bottomBar.add(leftFooter);
  bottomBar.add(stateRef);
  root.add(bottomBar);

  const ACTIVE_TAB = 0;
  let cardIdx = 0;

  const renderTabs = (): void => {
    for (let i = 0; i < TABS.length; i++) {
      const active = i === ACTIVE_TAB;
      const ref    = tabRefs[i]!;

      ref.cell.border = active ? ['top', 'left', 'right'] : false;

      const badgeBg = active ? C.accent : C.line2;
      ref.badgeBox.backgroundColor = badgeBg;
      ref.badgeText.bg             = badgeBg;
      ref.badgeText.fg             = active ? C.dark : C.slate;

      // Label: bold ink on active, slate on inactive.
      ref.label.fg         = active ? C.white : C.slate;
      ref.label.attributes = active ? TextAttributes.BOLD : 0;
    }
  };

  const renderCards = (): void => {
    for (let i = 0; i < cardRefs.length; i++) {
      const focused = i === cardIdx;
      cardRefs[i]!.box.borderColor       = focused ? C.red    : C.line2;
      cardRefs[i]!.badgeBox.backgroundColor = focused ? C.red : C.accent;
      cardRefs[i]!.badgeText.bg          = focused ? C.red    : C.accent;
      cardRefs[i]!.badgeText.fg          = C.dark;
    }
  };

  renderTabs();
  if (!isActive) renderCards();

  let live = true;
  let isChecking = false;

  const updateClock = (): void => {
    if (!live) return;
    if (activityClock) activityClock.content = clock();
  };

  function doRefresh(): void {
    if (isChecking) return;
    isChecking      = true;
    connDot.content = '○ checking';
    connDot.fg      = C.dim;

    fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!live) return;
        isChecking = false;
        if (!r.ok) {
          connDot.content = '● degraded';
          connDot.fg      = C.amber;
          return;
        }
        connDot.content = '● connected';
        connDot.fg      = C.emerald;
        const d = await r.json() as {
          websocket?: { router_stats?: { active_nodes?: number } };
        };
        if (!live) return;
        const nodes = d.websocket?.router_stats?.active_nodes;
        if (typeof nodes === 'number' && nodes > 0 && cardRefs[2]) {
          cardRefs[2]!.tag.content = `${nodes} node${nodes === 1 ? '' : 's'} · live`;
        }
      })
      .catch(() => {
        if (!live) return;
        isChecking      = false;
        connDot.content = '● offline';
        connDot.fg      = C.red;
      });
  }

  doRefresh();
  const clockTimer  = setInterval(updateClock, 1000);
  const healthTimer = setInterval(doRefresh, 15_000);

  // Active-mode 1Hz refresh — recomputes the full snapshot (workerRegistry
  // deltas, session aggregation, activity feed) and pushes it into the
  // dashboard's in-place update path. No-op when on the empty hero.
  const dashboardTimer = dashboard
    ? setInterval(() => { dashboard!.update(computeSnapshot()); }, 1000)
    : null;

  return new Promise<LandingAction>((resolve) => {
    let confirming = false;
    // While a modal (palette / tour) is open we suppress the landing's own
    // keypress handling — both handlers fire on the shared keyInput bus, so
    // this flag is how the landing yields the keyboard.
    let modalOpen  = false;

    const teardown = (): void => {
      live = false;
      clearInterval(clockTimer);
      clearInterval(healthTimer);
      if (dashboardTimer) clearInterval(dashboardTimer);
      renderer.destroy();
    };

    const done = (action: LandingAction): void => {
      teardown();
      resolve(action);
    };

    const openCard = (idx: number): void => {
      const card = CARDS[idx];
      if (!card) return;
      done(card.action);
    };

    const showChips = (): void => {
      hintsGroup.visible = true;
      hintsRef.content   = '';
    };
    const showInlineHint = (msg: string, fg: string): void => {
      hintsGroup.visible = false;
      hintsRef.content   = msg;
      hintsRef.fg        = fg;
    };

    // ── Palette commands ───────────────────────────────────────────────────
    // Defined inside the Promise so they can call `done(...)` to navigate.
    const buildCommands = (): PaletteCommand[] => ([
      { id: 'open-tunnels',   label: 'Open Tunnels',     hint: 'tab 2', keywords: ['nav'],
        run: () => done('tunnels') },
      { id: 'open-proxy',     label: 'Open Proxy',       hint: 'tab 3', keywords: ['nav'],
        run: () => done('proxy') },
      { id: 'open-nodes',     label: 'Open Nodes',       hint: 'tab 4', keywords: ['nav', 'ip', 'lease'],
        run: () => done('ips') },
      { id: 'open-websocket', label: 'Open WebSocket',   hint: 'tab 5', keywords: ['nav', 'ws'],
        run: () => done('websockets') },
      { id: 'open-settings',  label: 'Open Settings',    hint: 'tab 6', keywords: ['nav', 'prefs', 'config'],
        run: () => done('settings') },
      { id: 'proxy-forward',  label: 'Start Forward Proxy', keywords: ['proxy', 'outbound'],
        run: () => done('proxy-forward') },
      { id: 'proxy-reverse',  label: 'Start Reverse Proxy', keywords: ['proxy', 'inbound', 'cache'],
        run: () => done('proxy-reverse') },
      { id: 'refresh-health', label: 'Refresh Server Health', hint: 'R', keywords: ['ping', 'status'],
        run: () => doRefresh() },
      { id: 'open-docs',      label: 'Open Docs',        hint: 'd', keywords: ['help', 'reference'],
        run: () => openUrl(DOCS_URL) },
      { id: 'replay-tour',    label: 'Replay Tour',      hint: '?', keywords: ['walkthrough', 'help', 'onboarding'],
        run: () => { try { savePrefs({ tourCompleted: false }); } catch { /* non-fatal */ } void launchTour(); } },
      { id: 'edit-display-name', label: 'Edit Display Name', keywords: ['profile', 'identity', 'settings'],
        run: () => done('settings') },
      { id: 'quit',           label: 'Quit', hint: 'q',
        run: () => done('quit') },
    ]);

    const launchPalette = async (): Promise<void> => {
      if (modalOpen) return;
      modalOpen = true;
      try {
        const recents = loadPrefs().paletteRecents ?? [];
        await showPalette(renderer, root, {
          commands: buildCommands(),
          recents,
          onPick: (id) => {
            const next = [id, ...recents.filter(r => r !== id)].slice(0, 5);
            try { savePrefs({ paletteRecents: next }); } catch { /* non-fatal */ }
          },
        });
      } finally {
        modalOpen = false;
      }
    };

    const launchTour = async (): Promise<void> => {
      if (modalOpen) return;
      modalOpen = true;
      try {
        await showTour(renderer, root);
      } finally {
        modalOpen = false;
      }
    };

    // First-focus pulse — quick accent flash on the focused card so the
    // arrow-key affordance is obvious on first paint. Two beats: focus
    // colour → accent → focus colour. Skipped in active mode (no cards).
    let pulseCount = 0;
    let pulseTimer: ReturnType<typeof setInterval> | null = null;
    if (!isActive) {
      pulseTimer = setInterval(() => {
        if (!live) { if (pulseTimer) clearInterval(pulseTimer); return; }
        pulseCount++;
        const focused = cardRefs[cardIdx];
        if (!focused) return;
        focused.box.borderColor = pulseCount % 2 === 0 ? C.red : C.accent;
        if (pulseCount >= 4) {
          if (pulseTimer) clearInterval(pulseTimer);
          focused.box.borderColor = C.red;
        }
      }, 220);
    }

    // Tour is opt-in: press `?` or run "Replay Tour" from the palette.
    // No auto-launch — too intrusive for repeat / power users.

    renderer.keyInput.on('keypress', (key) => {
      if (!live || modalOpen) return;

      if (confirming) {
        if (key.name === 'y' || key.name === 'Y') { done('quit'); return; }
        confirming = false;
        showChips();
        return;
      }

      // Modal triggers — handled before everything else so they win against
      // any incidental key collisions.
      if (key.name === '/' || key.sequence === '/') { void launchPalette(); return; }
      if (key.name === '?' || key.sequence === '?') { void launchTour();    return; }
      if (key.name === 'd' || key.name === 'D')     { openUrl(DOCS_URL);   return; }

      const num = TABS.find(t => t.key === key.name);
      if (num) {
        if (num.action === 'home') return;
        done(num.action);
        return;
      }

      // `n` in active mode is shorthand for "new service" — opens the
      // palette so the user can pick which kind. Empty mode doesn't claim it
      // (the cards already cover "new" in a more discoverable way).
      if (isActive && (key.name === 'n' || key.name === 'N')) {
        void launchPalette();
        return;
      }

      // Active mode: ↑↓ / j k navigate the ACTIVE SERVICES rows.
      if (isActive && dashboard) {
        if (key.name === 'up' || key.name === 'k') {
          serviceIdx = Math.max(0, serviceIdx - 1);
          dashboard.setSelection(serviceIdx);
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          serviceIdx = Math.min(dashboard.rowCount - 1, serviceIdx + 1);
          dashboard.setSelection(serviceIdx);
          return;
        }
      }

      // Card focus navigation — only meaningful in empty mode where cards exist.
      if (!isActive) {
        if (key.name === 'left'  || key.name === 'h') {
          cardIdx = (cardIdx - 1 + CARDS.length) % CARDS.length;
          renderCards();
          return;
        }
        if (key.name === 'right' || key.name === 'l') {
          cardIdx = (cardIdx + 1) % CARDS.length;
          renderCards();
          return;
        }
        if (key.name === 'up'    || key.name === 'k') { cardIdx = (cardIdx - 1 + CARDS.length) % CARDS.length; renderCards(); return; }
        if (key.name === 'down'  || key.name === 'j') { cardIdx = (cardIdx + 1) % CARDS.length;                 renderCards(); return; }
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (isActive && dashboard) {
          // Navigate to the management screen for the selected service.
          // Idle slots open the palette (so the user can start something).
          const svc = dashboard.getServiceAt(serviceIdx);
          if (!svc || svc.type === 'idle') {
            void launchPalette();
          } else if (svc.type === 'tnl') {
            done('tunnels');
          } else if (svc.type === 'prx' || svc.type === 'fwd') {
            done('proxy');
          } else if (svc.type === 'ws') {
            done('websockets');
          }
          return;
        }
        // Empty mode: open the focused service card.
        openCard(cardIdx);
        return;
      }

      if (key.name === 'r' || key.name === 'R') { doRefresh(); return; }

      if (key.ctrl && key.name === 'c') { done('quit'); return; }
      if (key.name === 'q' || key.name === 'Q') {
        confirming = true;
        showInlineHint('Quit consensus?   [Y] yes   [any] cancel', C.amber);
        return;
      }
    });
  });
}
