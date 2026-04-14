/**
 * TUI Navigator
 *
 * Single source of truth for all screen routes.
 * To add a new screen: import it here and add one entry to ROUTES.
 */

import { showLanding, type LandingAction } from './screens/landing';
import { showTunnels }    from './screens/tunnel/list';
import { showProxy }      from './screens/proxy/index';
import { showWebsockets } from './screens/websockets';
import { showIps }        from './screens/ips';
import { showSettings }   from './screens/settings';
import { writeTraceLog }  from '../lib/crash-log';

const ROUTES: Record<string, () => Promise<unknown>> = {
  tunnels:       () => showTunnels(),
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
