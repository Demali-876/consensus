import { showProxyHub, registerWorker, removeWorker, type WorkerEntry } from './proxy-hub.js';
import { showForwardSetup }   from './forward-setup.js';
import { showReverseSetup }   from './reverse-setup.js';
import { showProxyDashboard } from './proxy-dashboard.js';
import { dispatchProxy }      from '../../src/proxy-worker.js';
import chalk                  from 'chalk';

async function runForward(): Promise<void> {
  const setup = await showForwardSetup();
  if (!setup) return;

  let handle;
  try {
    handle = await dispatchProxy({
      type:           'forward',
      port:           setup.listenPort,
      nodeRegion:     setup.nodeRegion,
      nodeDomain:     setup.nodeDomain,
      nodeExclude:    setup.nodeExclude,
      routes:         setup.routes,
      mode:           setup.mode,
      matchSubroutes: setup.matchSubroutes,
      cacheTtl:       setup.cacheTtl,
      verbose:        setup.verbose,
      budget:         setup.budget,
      preferNetwork:  setup.preferNetwork,
    });
  } catch (err) {
    console.error(chalk.red('Failed to start forward proxy:'), (err as Error).message);
    await pause();
    return;
  }

  const label = setup.nodeDomain ?? setup.nodeRegion ?? 'auto';
  const entry: WorkerEntry = { handle, startedAt: Date.now(), label, budget: setup.budget };
  registerWorker(entry);
  await showProxyDashboard(entry, () => removeWorker(entry));
}

async function runReverse(): Promise<void> {
  const setup = await showReverseSetup();
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
    console.error(chalk.red('Failed to start reverse proxy:'), (err as Error).message);
    await pause();
    return;
  }

  const label = `${setup.upstream.host}:${setup.upstream.port}`;
  const entry: WorkerEntry = { handle, startedAt: Date.now(), label };
  registerWorker(entry);
  await showProxyDashboard(entry, () => removeWorker(entry));
}

export async function showProxy(startMode?: 'forward' | 'reverse'): Promise<'back'> {
  if (startMode) {
    if (startMode === 'forward') await runForward();
    else                         await runReverse();
    return 'back';
  }

  while (true) {
    const action = await showProxyHub();

    if (action.kind === 'back')    return 'back';
    if (action.kind === 'forward') { await runForward(); continue; }
    if (action.kind === 'reverse') { await runReverse(); continue; }
    if (action.kind === 'manage')  {
      await showProxyDashboard(action.entry, () => removeWorker(action.entry));
      continue;
    }
  }
}

function pause(): Promise<void> {
  return new Promise(r => setTimeout(r, 1500));
}
