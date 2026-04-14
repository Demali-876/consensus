// proxy-hub.ts — Worker registry + proxy hub screen.

import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C }                     from '../../../theme';
import type { AppState } from '../../../lib/app-manager.js';
import type { ProxyWorkerHandle } from '../../../../src/proxy-worker.js';

export type WorkerEntry = {
  handle:    ProxyWorkerHandle;
  startedAt: number;
  label:     string;
  budget?:   number;
  appPort?:      number;
  appEntry?:     string;
  appCheckPath?: string;
  autoLaunch?: boolean;
  managedApp?: AppState;
  // Consensus ProxyClient options threaded into the preload file on launch
  cacheTtl?:       number;
  verbose?:        boolean;
  nodeRegion?:     string;
  nodeDomain?:     string;
  nodeExclude?:    string;
  preferNetwork?:  string;
  mode?:           'inclusive' | 'exclusive';
  routes?:         string[];
  matchSubroutes?: boolean;
};

// Persists across screen navigations
export const workerRegistry: WorkerEntry[] = [];

export function registerWorker(entry: WorkerEntry): void {
  workerRegistry.push(entry);
}

export function removeWorker(entry: WorkerEntry): void {
  const idx = workerRegistry.indexOf(entry);
  if (idx !== -1) workerRegistry.splice(idx, 1);
}

export type HubAction =
  | { kind: 'forward' }
  | { kind: 'reverse' }
  | { kind: 'manage'; entry: WorkerEntry }
  | { kind: 'back' };

const MAX_WORKER_SLOTS = 8;

function fmtHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

export async function showProxyHub(): Promise<HubAction> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'PROXY',     fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, {
    content: '[↑↓  navigate]  [↵  select]  [B  back]', fg: C.slate, bg: C.panel,
  }));
  bottomBar.add(new TextRenderable(renderer, { content: 'PROXY', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  const addText = (text: string, fg = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text, fg, bg: C.dark });
    content.add(t);
    return t;
  };

  addText('RUNNING  ' + '─'.repeat(42), C.dim);

  const workerRefs: TextRenderable[] = [];
  for (let i = 0; i < MAX_WORKER_SLOTS; i++) workerRefs.push(addText(' '));

  addText(' ');
  addText('NEW CONNECTION  ' + '─'.repeat(35), C.dim);
  addText(' ');

  const forwardRef = addText('', C.slate);
  const reverseRef = addText('', C.slate);

  let cursor = 0;

  function clampCursor(): void {
    cursor = Math.max(0, Math.min(cursor, workerRegistry.length + 1));
  }

  function render(): void {
    clampCursor();
    const workers = workerRegistry.slice(0, MAX_WORKER_SLOTS);

    for (let i = 0; i < MAX_WORKER_SLOTS; i++) {
      const entry = workers[i];
      if (!entry) {
        workerRefs[i]!.content = ' ';
        workerRefs[i]!.fg = C.dark;
        continue;
      }
      const sel   = cursor === i;
      const type  = entry.handle.type;
      const up    = fmtHms(Date.now() - entry.startedAt);
      workerRefs[i]!.content = `${sel ? '▶ ' : '  '}● ${type}   :${entry.handle.port}   ${entry.label}   ${up}`;
      workerRefs[i]!.fg = sel ? C.white   : C.emerald;
      workerRefs[i]!.bg = sel ? C.panel   : C.dark;
    }

    const fwdSel = cursor === workers.length;
    forwardRef.content = `${fwdSel ? '▶ ' : '  '}Forward Proxy    route outbound traffic through the consensus network`;
    forwardRef.fg = fwdSel ? C.white : C.slate;
    forwardRef.bg = fwdSel ? C.panel : C.dark;

    const revSel = cursor === workers.length + 1;
    reverseRef.content = `${revSel ? '▶ ' : '  '}Reverse Proxy    protect a local server with a caching proxy`;
    reverseRef.fg = revSel ? C.white : C.slate;
    reverseRef.bg = revSel ? C.panel : C.dark;
  }

  render();
  const ticker = setInterval(render, 1000);

  return new Promise<HubAction>((resolve) => {
    const done = (action: HubAction): void => {
      clearInterval(ticker);
      renderer.destroy();
      resolve(action);
    };

    renderer.keyInput.on('keypress', (key) => {
      const count = workerRegistry.length + 2;
      if (key.name === 'up'   || key.name === 'k') { cursor = (cursor - 1 + count) % count; render(); return; }
      if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % count; render(); return; }
      if (key.name === 'return' || key.name === 'enter') {
        const workers = workerRegistry.slice(0, MAX_WORKER_SLOTS);
        if (cursor < workers.length)       done({ kind: 'manage', entry: workers[cursor]! });
        else if (cursor === workers.length) done({ kind: 'forward' });
        else                               done({ kind: 'reverse' });
        return;
      }
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) done({ kind: 'back' });
    });
  });
}
