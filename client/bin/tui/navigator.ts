import { showLanding, type LandingAction } from './screens/landing';
import { showTunnelSetup } from './screens/tunnel/setup';
import { showTunnelDashboard } from './screens/tunnel/dashboard';
import { showProxy }      from './screens/proxy/index';
import { showWebsockets } from './screens/websockets';
import { showIps }        from './screens/ips';
import { showSettings }   from './screens/settings';
import { writeTraceLog }  from '../lib/crash-log';
import { ensureJetBrainsMono } from '../lib/font-check';
import { getActiveTunnel, stopTunnel } from '../lib/tunnel-runtime';

// The tunnels route is special: if a tunnel is already running, jump straight
// to the live dashboard (re-attaches without restarting). Otherwise go to setup,
// which will start a new tunnel and hand off to the dashboard itself.
async function routeTunnels(): Promise<void> {
  const active = getActiveTunnel();
  if (active) {
    await showTunnelDashboard(active.setup);
    return;
  }
  await showTunnelSetup();
}

const ROUTES: Record<string, () => Promise<unknown>> = {
  tunnels:       () => routeTunnels(),
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

  // The user is quitting the TUI for real — tear down any tunnel still attached
  // to this process so the WS and local sockets don't leak.
  if (getActiveTunnel()) {
    try { await stopTunnel(); } catch { /* best-effort */ }
  }

  writeTraceLog('navigator.exit');
}
