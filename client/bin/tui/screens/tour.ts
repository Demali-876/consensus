import {
  type CliRenderer,
  type Renderable,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../theme';
import { savePrefs } from '../../lib/store';

type Pct = `${number}%`;

interface Step {
  title:  string;
  body:   string;
  anchor: { top: Pct; left: Pct; width: Pct };
}

const STEPS: Step[] = [
  {
    title:  'Status bar',
    body:   'Connection, account, tier and version live up here. The dot turns amber when the server is degraded, red when offline.',
    anchor: { top: '15%', left: '10%', width: '55%' },
  },
  {
    title:  'Tabs',
    body:   'Six screens, one per number key (1 Home … 6 Settings). Active tab pops out of the rule line below.',
    anchor: { top: '20%', left: '10%', width: '55%' },
  },
  {
    title:  'Service cards',
    body:   'Each card launches a service. Use ← → to focus, ↵ to open, or just press the number on the badge (2–5).',
    anchor: { top: '40%', left: '10%', width: '55%' },
  },
  {
    title:  'Command palette & footer keys',
    body:   'Press / any time for the command palette. ? replays this tour. d opens docs. q quits with confirm.',
    anchor: { top: '60%', left: '10%', width: '55%' },
  },
  {
    title:  "You're set",
    body:   'Hit ↵ to dismiss. Re-open the tour any time from the command palette → "Replay tour".',
    anchor: { top: '30%', left: '20%', width: '50%' },
  },
];

export async function showTour(
  renderer: CliRenderer,
  root: Renderable,
): Promise<void> {
  let step = 0;

  const overlay = new BoxRenderable(renderer, {
    id: 'tour-overlay',
    position: 'absolute',
    top:   STEPS[0]!.anchor.top,
    left:  STEPS[0]!.anchor.left,
    width: STEPS[0]!.anchor.width,
    flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.accent,
    backgroundColor: C.panel,
    padding: 1,
  });

  const stepCounter = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  const titleRef = new TextRenderable(renderer, {
    content: '', fg: C.white, bg: C.panel,
    attributes: TextAttributes.BOLD,
  });
  const bodyRef = new TextRenderable(renderer, {
    content: '', fg: C.slate, bg: C.panel,
  });
  const hintsRef = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.panel,
  });

  overlay.add(stepCounter);
  overlay.add(titleRef);
  overlay.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.panel }));
  overlay.add(bodyRef);
  overlay.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.panel }));
  overlay.add(hintsRef);

  const render = (): void => {
    const s = STEPS[step]!;
    overlay.top   = s.anchor.top;
    overlay.left  = s.anchor.left;
    overlay.width = s.anchor.width;
    stepCounter.content = `STEP ${step + 1} / ${STEPS.length}`;
    titleRef.content    = s.title;
    bodyRef.content     = s.body;
    const last = step === STEPS.length - 1;
    hintsRef.content = last
      ? '↵ finish    ←  back    s  skip'
      : '→ / ↵ next    ←  back    s  skip';
  };

  render();
  root.add(overlay);

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      renderer.keyInput.off('keypress', onKey);
      root.remove('tour-overlay');
      try { savePrefs({ tourCompleted: true }); } catch { /* non-fatal */ }
      resolve();
    };

    const onKey = (key: { name?: string; ctrl?: boolean }): void => {
      if (done) return;
      if (key.name === 'escape' || key.name === 's' || (key.ctrl && key.name === 'c')) {
        finish();
        return;
      }
      if (key.name === 'left') {
        step = Math.max(0, step - 1);
        render();
        return;
      }
      if (key.name === 'right' || key.name === 'return' || key.name === 'enter') {
        if (step === STEPS.length - 1) { finish(); return; }
        step++;
        render();
        return;
      }
    };

    renderer.keyInput.on('keypress', onKey);
  });
}
