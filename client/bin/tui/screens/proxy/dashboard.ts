// proxy-dashboard.ts — Live stats dashboard for a running proxy worker.

import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { launchManagedApp, probeManagedApp, probeManagedAppUntilReady, stopManagedApp } from '../../../lib/app-manager.js';
import { writeTraceLog } from '../../../lib/crash-log';
import { C } from '../../../theme';
import type { WorkerEntry } from './hub.js';

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(2)} MB`;
}

function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(1)} B/s`;
  if (bps < 1_048_576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1_048_576).toFixed(1)} MB/s`;
}

function fmtLatency(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

function fmtAgo(at?: number): string {
  if (!at) return 'never';
  return fmtMs(Date.now() - at);
}

function budgetBar(spent: number, limit: number, width = 16): string {
  const filled = Math.round(Math.min(spent / limit, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return ' '.repeat(width);
  const ticks = '▁▂▃▄▅▆▇█';
  const window = values.slice(-width);
  const max = Math.max(...window, 1);
  return window.map((value) => {
    const idx = Math.min(ticks.length - 1, Math.round((value / max) * (ticks.length - 1)));
    return ticks[idx]!;
  }).join('').padEnd(width, ' ');
}

function outcomeStrip(outcomes: boolean[], width = 40): string {
  if (outcomes.length === 0) return ' '.repeat(width);
  const window = outcomes.slice(-width);
  return window.map((ok) => ok ? '■' : '·').join('').padEnd(width, ' ');
}

export async function showProxyDashboard(
  entry: WorkerEntry,
  onStop?: () => void,
): Promise<'back'> {
  const isForward = entry.handle.type === 'forward';
  const title = isForward ? 'FORWARD PROXY' : 'REVERSE PROXY';
  writeTraceLog('proxyDashboard.enter', { type: entry.handle.type, port: entry.handle.port, label: entry.label });

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 15,
    useMouse: false,
    useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingX: 2,
    paddingY: 0,
    backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: title, fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    paddingX: 3,
    paddingTop: 2,
    backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingX: 2,
    paddingY: 0,
    backgroundColor: C.panel,
  });
  const controls = isForward
    ? '[L launch]  [T test]  [S stop]  [B back]'
    : '[S stop]  [B back]';
  bottomBar.add(new TextRenderable(renderer, { content: controls, fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: title, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  const addText = (text: string, fg: string = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text || ' ', fg, bg: C.dark });
    content.add(t);
    return t;
  };

  const statusRef      = addText('', C.emerald);
  const uptimeRef      = addText('', C.dim);
  const subtitleRef    = addText('', C.slate);
  addText(' ');

  addText('OVERVIEW  ' + '─'.repeat(43), C.dim);
  addText(' ');
  const requestsRef    = addText('');
  const cacheRef       = addText('');
  const throughputRef  = addText('');
  const spendRef       = addText('');
  const budgetRef      = addText('');

  addText(' ');
  addText('RECENT CHECKS  ' + '─'.repeat(38), C.dim);
  addText(' ');
  const checksRef      = addText('', C.emerald);

  addText(' ');
  addText('LATENCY (LAST 40)  ' + '─'.repeat(31), C.dim);
  addText(' ');
  const latencyGraphRef = addText('', C.emerald);
  const latencyScaleRef = addText('', C.dim);
  const latencyStatsRef = addText('');

  const appStateRef = isForward ? addText('') : null;
  const appProbeRef = isForward ? addText('') : null;
  const appCmdRef   = isForward ? addText('') : null;
  const appEnvRef1  = isForward ? addText('', C.cyan) : null;
  const appEnvRef2  = isForward ? addText('', C.cyan) : null;
  const appLogRef   = isForward ? addText('', C.dim) : null;

  let prevStats = entry.handle.stats();
  let prevTime = Date.now();
  let actionBusy = false;

  const ensureManagedAppRunning = async (): Promise<void> => {
    if (!entry.managedApp) return;
    await Bun.sleep(250);
    if (entry.managedApp.status === 'exited' || entry.managedApp.status === 'error') {
      throw new Error(entry.managedApp.lastMessage ?? 'managed app exited before it became ready');
    }
  };

  const autoManageApp = async (): Promise<void> => {
    if (!isForward || !entry.managedApp || !entry.appEntry || !entry.autoLaunch) return;
    actionBusy = true;
    try {
      writeTraceLog('proxyDashboard.autoLaunch.start', { port: entry.handle.port, appPort: entry.appPort });
      await launchManagedApp(entry.managedApp, {
        proxyPort:      entry.handle.port,
        appPort:        entry.appPort,
        label:          `app-${entry.appPort ?? entry.handle.port}`,
        cacheTtl:       entry.cacheTtl,
        verbose:        entry.verbose,
        nodeRegion:     entry.nodeRegion,
        nodeDomain:     entry.nodeDomain,
        nodeExclude:    entry.nodeExclude,
        budget:         entry.budget,
        preferNetwork:  entry.preferNetwork,
        mode:           entry.mode,
        routes:         entry.routes,
        matchSubroutes: entry.matchSubroutes,
      });
      render();
      await ensureManagedAppRunning();
      await probeManagedAppUntilReady(entry.managedApp, {
        appPort: entry.appPort,
        checkPath: entry.appCheckPath,
        attempts: 8,
        intervalMs: 1000,
      });
      writeTraceLog('proxyDashboard.autoLaunch.done', {
        port: entry.handle.port,
        ok: entry.managedApp.lastProbe?.ok === true,
        message: entry.managedApp.lastProbe?.message,
      });
    } catch (err) {
      entry.managedApp.status = 'error';
      entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
      writeTraceLog('proxyDashboard.autoLaunch.error', {
        port: entry.handle.port,
        message: entry.managedApp.lastMessage,
      });
    } finally {
      actionBusy = false;
      render();
    }
  };

  const render = () => {
    const stats = entry.handle.stats();
    const now = Date.now();
    const dt = Math.max((now - prevTime) / 1000, 1);

    const reqRate  = ((stats.requests - prevStats.requests) / dt) * 60;
    const sentRate = (stats.bytesSent - prevStats.bytesSent) / dt;
    const recvRate = (stats.bytesRecv - prevStats.bytesRecv) / dt;
    prevStats = stats;
    prevTime = now;

    const spend = stats.spend ?? 0;
    const exhausted = isForward && entry.budget != null && spend >= entry.budget * 0.99;
    statusRef.fg = exhausted ? C.red : C.emerald;
    statusRef.content = `● ${exhausted ? 'EXHAUSTED' : 'RUNNING'}    :${entry.handle.port}    ${entry.label}`;
    uptimeRef.content = `  uptime ${fmtMs(stats.uptime)}    last status ${stats.lastStatusCode ?? '—'}`;
    subtitleRef.content = isForward
      ? `  app ${entry.appPort ? `:${entry.appPort}` : '—'} → consensus (preload)`
      : `  upstream traffic protected on local proxy :${entry.handle.port}`;

    requestsRef.content = `  requests      ${String(stats.requests).padEnd(8)} ${reqRate.toFixed(1)} / min`;
    const cacheHits = stats.cacheHits ?? 0;
    const hitPct = stats.requests > 0 ? Math.round((cacheHits / stats.requests) * 100) : 0;
    cacheRef.content = isForward
      ? '  cache hits     n/a      reverse only'
      : `  cache hits     ${String(cacheHits).padEnd(8)} ${String(hitPct).padStart(3)}%`;
    throughputRef.content = `  throughput    ↑ ${fmtBytes(stats.bytesSent).padEnd(10)} ${fmtRate(sentRate)}   ↓ ${fmtBytes(stats.bytesRecv).padEnd(10)} ${fmtRate(recvRate)}`;
    spendRef.content = isForward
      ? `  spend         $${spend.toFixed(6).padEnd(10)} ${fmtLatency(stats.currentLatencyMs)} current`
      : `  spend         $${spend.toFixed(6).padEnd(10)} cache-aware reverse mode`;

    if (entry.budget != null) {
      const pct = Math.min(spend / entry.budget, 1);
      budgetRef.content = `  budget        ${budgetBar(spend, entry.budget)}  ${Math.round(pct * 100)}%   $${Math.max(entry.budget - spend, 0).toFixed(6)} left`;
      budgetRef.fg = pct > 0.8 ? C.red : pct > 0.5 ? C.amber : C.slate;
    } else {
      budgetRef.content = '  budget        unlimited';
      budgetRef.fg = C.dim;
    }

    checksRef.content = `  ${outcomeStrip(stats.recentOutcomes ?? [])}`;
    checksRef.fg = (stats.recentOutcomes ?? []).some((ok) => !ok) ? C.amber : C.emerald;

    latencyGraphRef.content = `  ${sparkline(stats.recentLatencies ?? [])}`;
    latencyScaleRef.content = `  current ${fmtLatency(stats.currentLatencyMs).padEnd(10)} avg ${fmtLatency(stats.avgLatencyMs).padEnd(10)} p95 ${fmtLatency(stats.p95LatencyMs).padEnd(10)}`;
    latencyStatsRef.content = `  success ${Math.round((((stats.recentOutcomes ?? []).filter(Boolean).length) / Math.max((stats.recentOutcomes ?? []).length, 1)) * 100)}%   samples ${(stats.recentLatencies ?? []).length}`;

    if (isForward && entry.managedApp && appStateRef && appProbeRef && appCmdRef && appEnvRef1 && appEnvRef2 && appLogRef) {
      const managed = entry.managedApp;
      appStateRef.content = `APP CONTROL  ${'─'.repeat(40)}`;
      appStateRef.fg = C.dim;
      appProbeRef.content = `  app status     ${managed.status.padEnd(10)} ${managed.lastMessage ?? 'ready to launch'}${managed.pid ? `   pid ${managed.pid}` : ''}`;
      appProbeRef.fg = managed.status === 'error' ? C.red : managed.status === 'running' ? C.emerald : C.slate;

      const probe = managed.lastProbe;
      appCmdRef.content = probe
        ? `  last probe     ${probe.ok ? 'reachable' : 'failed'}   ${probe.message}   ${fmtLatency(probe.latencyMs)}   ${fmtAgo(probe.at)} ago`
        : `  last probe     ${entry.appPort ? `http://127.0.0.1:${entry.appPort}${entry.appCheckPath ?? '/'}` : 'no app port configured'}`;
      appCmdRef.fg = probe ? (probe.ok ? C.emerald : C.amber) : C.slate;
      const launchCmd = entry.appEntry
        ? `bun --preload ${managed.preloadPath ?? '.consensus-preload.ts'} ${entry.appEntry}`
        : undefined;
      appEnvRef1.content = launchCmd
        ? `  launch cmd     ${launchCmd}`
        : '  launch cmd     set an entry file in forward setup to enable auto-launch';
      appEnvRef2.content = `  fetch mode     preload → globalThis.fetch → consensus`;
      appLogRef.content  = managed.preloadPath
        ? `  preload        ${managed.preloadPath}${managed.logPath ? `   log ${managed.logPath}` : ''}`
        : `  preload        .consensus-preload.ts${entry.autoLaunch ? '   auto restart enabled' : ''}`;
    }
  };

  render();
  const ticker = setInterval(render, 1000);
  const inputReadyAt = Date.now() + 300;
  void autoManageApp();

  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', async (key) => {
      if (Date.now() < inputReadyAt || actionBusy) return;

      if (isForward && (key.name === 'l' || key.name === 'L') && entry.managedApp) {
        if (!entry.appEntry) return;
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'launch', port: entry.handle.port });
          await launchManagedApp(entry.managedApp, {
            proxyPort:      entry.handle.port,
            appPort:        entry.appPort,
            label:          `app-${entry.appPort ?? entry.handle.port}`,
            cacheTtl:       entry.cacheTtl,
            verbose:        entry.verbose,
            nodeRegion:     entry.nodeRegion,
            nodeDomain:     entry.nodeDomain,
            nodeExclude:    entry.nodeExclude,
            budget:         entry.budget,
            preferNetwork:  entry.preferNetwork,
            mode:           entry.mode,
            routes:         entry.routes,
            matchSubroutes: entry.matchSubroutes,
          });
          await ensureManagedAppRunning();
        } catch (err) {
          entry.managedApp.status = 'error';
          entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
        } finally {
          actionBusy = false;
          render();
        }
        return;
      }

      if (key.name === 't' || key.name === 'T') {
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'test', port: entry.handle.port });
          if (isForward && entry.managedApp) {
            await probeManagedApp(entry.managedApp, {
              appPort: entry.appPort,
              checkPath: entry.appCheckPath,
            });
          }
        } catch (err) {
          if (entry.managedApp) {
            entry.managedApp.lastMessage = err instanceof Error ? err.message : String(err);
          }
        } finally {
          actionBusy = false;
          render();
        }
        return;
      }

      if (key.name === 's' || key.name === 'S') {
        writeTraceLog('proxyDashboard.key', { key: key.name, action: 'stop', port: entry.handle.port });
        clearInterval(ticker);
        renderer.destroy();
        if (entry.managedApp?.process) await stopManagedApp(entry.managedApp);
        await entry.handle.stop();
        onStop?.();
        resolve('back');
        return;
      }

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        writeTraceLog('proxyDashboard.key', { key: key.name, ctrl: key.ctrl === true, action: 'back', port: entry.handle.port });
        clearInterval(ticker);
        renderer.destroy();
        resolve('back');
      }
    });
  });
}
