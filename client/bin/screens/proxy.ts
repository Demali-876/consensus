import { showProxyHub, registerWorker, removeWorker, type WorkerEntry } from './proxy-hub.js';
import { showForwardSetup }   from './forward-setup.js';
import { showReverseSetup }   from './reverse-setup.js';
import { showProxyDashboard } from './proxy-dashboard.js';
import { dispatchProxy }      from '../../src/proxy-worker.js';
import type { ProxyWorkerHandle, WorkerStats } from '../../src/proxy-worker.js';
import { createAppState } from '../lib/app-manager.js';
import { writeCrashLog, writeTraceLog } from '../lib/crash-log';
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C }                  from '../theme';

function createPreloadHandle(): ProxyWorkerHandle {
  const startedAt = Date.now();
  const stats = (): WorkerStats => ({
    requests: 0, bytesSent: 0, bytesRecv: 0,
    uptime: Date.now() - startedAt, spend: 0,
  });
  return { type: 'forward', port: 0, stats, stop: async () => {} };
}

async function runForward(): Promise<void> {
  writeTraceLog('proxy.runForward.enter');
  const setup = await showForwardSetup();
  writeTraceLog('proxy.runForward.afterSetup', { setup });
  if (!setup) return;

  const handle = createPreloadHandle();

  const routeLabel = setup.nodeDomain ?? setup.nodeRegion ?? 'auto';
  const label = setup.appPort ? `app:${setup.appPort} → ${routeLabel}` : routeLabel;
  const entry: WorkerEntry = {
    handle,
    startedAt: Date.now(),
    label,
    budget:         setup.budget,
    appPort:        setup.appPort,
    appEntry:       setup.appEntry,
    appCheckPath:   setup.appCheckPath,
    autoLaunch:     setup.autoLaunch,
    cacheTtl:       setup.cacheTtl,
    verbose:        setup.verbose,
    nodeRegion:     setup.nodeRegion,
    nodeDomain:     setup.nodeDomain,
    nodeExclude:    setup.nodeExclude,
    preferNetwork:  setup.preferNetwork,
    mode:           setup.mode,
    routes:         setup.routes,
    matchSubroutes: setup.matchSubroutes,
    managedApp:     createAppState(setup.appEntry, setup.appCheckPath),
  };
  registerWorker(entry);
  writeTraceLog('proxy.runForward.dashboard.enter', { port: handle.port, label, appPort: setup.appPort });
  await showProxyDashboard(entry, () => removeWorker(entry));
  writeTraceLog('proxy.runForward.dashboard.exit', { port: handle.port });
}

async function runReverse(): Promise<void> {
  writeTraceLog('proxy.runReverse.enter');
  const setup = await showReverseSetup();
  writeTraceLog('proxy.runReverse.afterSetup', { setup });
  if (!setup) return;

  let handle;
  try {
    handle = await dispatchProxy({
      type:          'reverse',
      upstream:      setup.upstream,
      port:          setup.listenPort || undefined,
      cache:         { ttl: setup.cacheTtl, maxSize: setup.cacheMaxSize },
      preferNetwork: setup.preferNetwork,
    });
  } catch (err) {
    const logPath = writeCrashLog('reverse proxy start', err, { setup });
    writeTraceLog('proxy.runReverse.startError', { message: err instanceof Error ? err.message : String(err), logPath });
    await showError('REVERSE PROXY', (err as Error).message, logPath);
    return;
  }

  const label = `${setup.upstream.host}:${setup.upstream.port}`;
  const entry: WorkerEntry = { handle, startedAt: Date.now(), label };
  registerWorker(entry);
  writeTraceLog('proxy.runReverse.dashboard.enter', { port: handle.port, label });
  await showProxyDashboard(entry, () => removeWorker(entry));
  writeTraceLog('proxy.runReverse.dashboard.exit', { port: handle.port });
}

export async function showProxy(startMode?: 'forward' | 'reverse'): Promise<'back'> {
  writeTraceLog('proxy.showProxy.enter', { startMode });
  if (startMode) {
    if (startMode === 'forward') await runForward();
    else                         await runReverse();
    writeTraceLog('proxy.showProxy.exit', { startMode });
    return 'back';
  }

  while (true) {
    const action = await showProxyHub();

    if (action.kind === 'back')    { writeTraceLog('proxy.showProxy.back'); return 'back'; }
    if (action.kind === 'forward') { await runForward(); continue; }
    if (action.kind === 'reverse') { await runReverse(); continue; }
    if (action.kind === 'manage')  {
      await showProxyDashboard(action.entry, () => removeWorker(action.entry));
      continue;
    }
  }
}

async function showError(context: string, message: string, logPath?: string): Promise<void> {
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
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white,  bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: context,     fg: C.slate,  bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 3, backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, { content: '[any key  dismiss]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: context,              fg: C.dim,   bg: C.panel }));
  root.add(bottomBar);

  const ln = (text: string, fg = C.slate) => {
    content.add(new TextRenderable(renderer, { content: text || ' ', fg, bg: C.dark }));
  };

  ln('ERROR  ' + '─'.repeat(45), C.dim);
  ln(' ');
  ln(`  ✕   Failed to start ${context.toLowerCase()}`, C.red);
  ln(' ');
  ln(`  ${message}`, C.slate);
  if (logPath) {
    ln(' ');
    ln(`  crash log: ${logPath}`, C.dim);
  }
  const inputReadyAt = Date.now() + 300;

  await new Promise<void>(resolve => {
    const onKeypress = () => {
      if (Date.now() < inputReadyAt) return;
      renderer.keyInput.off('keypress', onKeypress);
      renderer.destroy();
      resolve();
    };
    renderer.keyInput.on('keypress', onKeypress);
  });
}
