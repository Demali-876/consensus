import { showLanding, type LandingAction } from './screens/landing';
import { showTunnelSetup } from './screens/tunnel/setup';
import { showProxy }      from './screens/proxy/index';
import { showWebsockets } from './screens/websockets';
import { showIps }        from './screens/ips';
import { showSettings }   from './screens/settings';
import { writeTraceLog }  from '../lib/crash-log';
import { ensureJetBrainsMono } from '../lib/font-check';

const ROUTES: Record<string, () => Promise<unknown>> = {
  tunnels:       () => showTunnelSetup(),
  proxy:         () => showProxy(),
  'proxy-forward': () => showProxy('forward'),
  'proxy-reverse': () => showProxy('reverse'),
  'proxy-manage':  () => showProxy(),
  websockets:    () => showWebsockets(),
  ips:           () => showIps(),
  settings:      () => showSettings(),
};

export async function runTui(): Promise<void> {
  writeTraceLog('navigator.enter');

  ensureJetBrainsMono();

  let next: LandingAction = await showLanding();
  writeTraceLog('navigator.afterLanding', { next });

  while (next !== 'quit') {
    const handler = ROUTES[next];
    if (handler) {
      await handler();
    } else {
      writeTraceLog('navigator.unknownRoute', { next });
    }
    next = await showLanding();
    writeTraceLog('navigator.afterLanding', { next });
  }

  writeTraceLog('navigator.exit');
}
