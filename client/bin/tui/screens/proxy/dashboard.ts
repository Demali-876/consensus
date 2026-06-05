import { createCliRenderer, BoxRenderable } from '@opentui/core';
import {
  launchManagedApp,
  probeManagedApp,
  probeManagedAppUntilReady,
  stopManagedApp,
} from '../../../lib/app-manager.js';
import { writeTraceLog } from '../../../lib/crash-log';
import { isFreeMode } from '../../../lib/server-config';
import { saveSession, recordSpend } from '../../../lib/store.ts';
import { C } from '../../../theme';
import { makeKeyBar, makeTopBar, termCols } from '../../chrome.ts';
import {
  APP_PANEL_WIDTH,
  addMetricRows,
  addStatusStrip,
  budgetBar,
  compactPath,
  fmtAgo,
  fmtBytes,
  fmtCount,
  fmtHms,
  fmtLatency,
  fmtRate,
  makeChecksPanel,
  makeLatencyPanel,
  makeThroughputPanel,
  makeAppControlPanel,
  pct,
  sparkline,
  statusFg,
  statusText,
  successRate,
  updateChecks,
  updateMetric,
} from './dashboard-ui.ts';
import type { WorkerEntry } from './hub.js';
import type { WorkerStats } from '../../../../src/proxy-worker.js';

function makeRateTracker(initial: WorkerStats): {
  update(stats: WorkerStats): { reqRate: number; sentRate: number; recvRate: number };
} {
  let prevStats = initial;
  let prevTime = Date.now();
  return {
    update(stats: WorkerStats) {
      const now = Date.now();
      const dt = Math.max((now - prevTime) / 1000, 1);
      const reqRate = ((stats.requests - prevStats.requests) / dt) * 60;
      const sentRate = (stats.bytesSent - prevStats.bytesSent) / dt;
      const recvRate = (stats.bytesRecv - prevStats.bytesRecv) / dt;
      prevStats = stats;
      prevTime = now;
      return { reqRate, sentRate, recvRate };
    },
  };
}

export async function showProxyDashboard(
  entry: WorkerEntry,
  onStop?: () => void,
  opts: { freeMode?: boolean; preview?: boolean } = {},
): Promise<'back'> {
  const isForward = entry.handle.type === 'forward';
  const freeMode = opts.freeMode ?? await isFreeMode();
  const previewMode = opts.preview === true;
  const title = isForward ? 'FORWARD PROXY' : 'REVERSE PROXY';
  writeTraceLog('proxyDashboard.enter', { type: entry.handle.type, port: entry.handle.port, label: entry.label });

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  makeTopBar(renderer, root, { freeMode, status: '● live', statusColor: C.emerald });
  const statusStrip = addStatusStrip(renderer, root, entry, isForward);
  const metrics = addMetricRows(renderer, root, isForward, freeMode, entry.budget);
  const cols = termCols();
  const stacked = isForward && cols < 112;
  const appPanelWidth = Math.max(54, Math.min(APP_PANEL_WIDTH, Math.floor(cols * 0.42)));

  const lower = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1,
    flexDirection: stacked ? 'column' : isForward ? 'row' : 'column',
    gap: 2, paddingX: 2, paddingTop: 1, backgroundColor: C.dark,
  });
  root.add(lower);

  const left = new BoxRenderable(renderer, {
    flexGrow: 1, flexShrink: 1, flexDirection: 'column', gap: 1, backgroundColor: C.dark,
  });
  lower.add(left);

  const latency = makeLatencyPanel(renderer);
  const throughput = makeThroughputPanel(renderer);
  const checks = makeChecksPanel(renderer);
  left.add(latency.box);
  left.add(throughput.box);
  left.add(checks.box);

  const appPanel = isForward ? makeAppControlPanel(renderer, stacked ? '100%' : appPanelWidth) : null;
  if (appPanel) lower.add(appPanel.box);

  const footerHints = isForward
    ? [
        { key: 'L', label: 'launch' },
        { key: 'T', label: 'test' },
        { key: '↑↓', label: 'scroll' },
        { key: 'S', label: 'stop proxy', badgeBg: C.red },
        { key: 'B', label: 'back' },
      ]
    : [
        { key: '↑↓', label: 'scroll' },
        { key: 'S', label: 'stop proxy', badgeBg: C.red },
        { key: 'B', label: 'back' },
      ];
  root.add(makeKeyBar(renderer, footerHints, `${title} · LIVE`).box);

  let actionBusy = false;
  const sessionId = crypto.randomUUID();
  const rates = makeRateTracker(entry.handle.stats());

  const ensureManagedAppRunning = async (): Promise<void> => {
    if (!entry.managedApp) return;
    await Bun.sleep(250);
    if (entry.managedApp.status === 'exited' || entry.managedApp.status === 'error') {
      throw new Error(entry.managedApp.lastMessage ?? 'managed app exited before it became ready');
    }
  };

  const autoManageApp = async (): Promise<void> => {
    if (previewMode) return;
    if (!isForward || !entry.managedApp || !entry.appEntry || !entry.autoLaunch) return;
    actionBusy = true;
    try {
      writeTraceLog('proxyDashboard.autoLaunch.start', { port: entry.handle.port, appPort: entry.appPort });
      await launchManagedApp(entry.managedApp, {
        proxyPort: entry.handle.port,
        appPort: entry.appPort,
        label: `app-${entry.appPort ?? entry.handle.port}`,
        cacheTtl: entry.cacheTtl,
        verbose: entry.verbose,
        nodeRegion: entry.nodeRegion,
        nodeDomain: entry.nodeDomain,
        nodeExclude: entry.nodeExclude,
        budget: entry.budget,
        preferNetwork: entry.preferNetwork,
        mode: entry.mode,
        routes: entry.routes,
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

  function renderAppPanel(stats: WorkerStats): void {
    if (!isForward || !entry.managedApp || !appPanel) return;
    const managed = entry.managedApp;
    const state = actionBusy ? 'working' : managed.status;
    const ok = managed.status === 'running';
    const warn = managed.status === 'error' || managed.status === 'exited';
    appPanel.statusChip.content = `• ${state}`;
    appPanel.statusChip.fg = warn ? C.red : ok ? C.emerald : C.slate;
    appPanel.statusChipBox.borderColor = warn ? C.red : ok ? C.emerald : C.line2;
    appPanel.pid.content = managed.pid ? `pid ${managed.pid}` : 'pid —';

    const probe = managed.lastProbe;
    appPanel.probe.content = probe
      ? `${probe.ok ? 'reachable' : 'failed'} · ${probe.statusCode ?? probe.message} ${entry.appCheckPath ?? '/'} · ${fmtLatency(probe.latencyMs)} · ${fmtAgo(probe.at)} ago`
      : `${entry.appPort ? 'waiting' : 'no app port'} · ${entry.appCheckPath ?? '/'} · ${managed.lastMessage ?? 'not probed yet'}`;
    appPanel.probe.fg = probe ? (probe.ok ? C.emerald : C.amber) : C.slate;

    const preloadName = managed.preloadPath ? compactPath(managed.preloadPath, 24) : '.consensus-preload.ts';
    appPanel.launch.content = entry.appEntry
      ? `bun --preload ${preloadName} ${compactPath(entry.appEntry, 22)}`
      : 'set an entry file in forward setup to enable auto-launch';
    appPanel.fetchMode.content = 'preload → globalThis.fetch → consensus';
    appPanel.preload.content = `${preloadName} · auto restart ${entry.autoLaunch ? 'enabled' : 'disabled'}`;
    appPanel.routing.content = `${entry.mode ?? 'inclusive'} · ${(entry.routes?.length ? entry.routes.join(', ') : 'all routes')} · subroutes ${entry.matchSubroutes ? 'on' : 'off'}`;
    appPanel.node.content = `${entry.nodeDomain ?? entry.nodeRegion ?? 'auto'} · auto · ${fmtLatency(stats.avgLatencyMs)}`;
  }

  function render(): void {
    const stats = entry.handle.stats();
    const rate = rates.update(stats);
    const spend = stats.spend ?? 0;
    const outcomes = stats.recentOutcomes ?? [];
    const success = successRate(outcomes);
    const exhausted = isForward && entry.budget != null && spend >= entry.budget * 0.99;

    statusStrip.state.content = `● ${exhausted ? 'EXHAUSTED' : 'RUNNING'} :${entry.handle.port}`;
    statusStrip.state.fg = exhausted ? C.red : C.emerald;
    statusStrip.uptime.content = `uptime ${fmtHms(stats.uptime)}`;
    if (!isForward) {
      statusStrip.center.content = `upstream ${entry.label || 'localhost:3000'} → proxy :${entry.handle.port} · cached`;
    }

    updateMetric(metrics.requests, fmtCount(stats.requests), '', `~${Math.max(0, Math.round(rate.reqRate))} / min`, C.amber);
    updateMetric(metrics.status, stats.lastStatusCode == null ? '—' : String(stats.lastStatusCode), '', statusText(stats.lastStatusCode), statusFg(stats.lastStatusCode));

    const cacheHits = stats.cacheHits ?? 0;
    const hitRate = stats.requests > 0 ? (cacheHits / stats.requests) * 100 : 0;
    updateMetric(
      metrics.cache,
      isForward ? 'n/a' : fmtCount(cacheHits),
      '',
      isForward ? 'reverse only' : `${Math.round(hitRate)}% hit rate`,
      isForward ? C.slate : C.white,
    );
    updateMetric(metrics.success, String(Math.round(success)), '%', 'last 40 checks', C.emerald);

    if (metrics.spend) {
      updateMetric(metrics.spend, `$${spend.toFixed(6)}`, '', 'session total', C.white);
    }
    if (metrics.budget) {
      const budget = entry.budget ?? 0;
      if (budget > 0) {
        const budgetPct = Math.min(spend / budget, 1);
        const budgetLabel = pct(budgetPct * 100);
        const barWidth = Math.max(4, Math.min(22, metrics.budget.width - 7 - budgetLabel.length));
        updateMetric(
          metrics.budget,
          `${budgetBar(spend, budget, barWidth)} ${budgetLabel}`,
          '',
          `$${Math.max(budget - spend, 0).toFixed(2)} left`,
          budgetPct > 0.8 ? C.red : C.slate,
        );
      } else {
        updateMetric(metrics.budget, 'unlimited', '', 'no session cap', C.slate);
      }
    }

    latency.spark.content = sparkline(stats.recentLatencies ?? []);
    latency.current.content = fmtLatency(stats.currentLatencyMs);
    latency.avg.content = fmtLatency(stats.avgLatencyMs);
    latency.p95.content = fmtLatency(stats.p95LatencyMs);
    latency.samples.content = String((stats.recentLatencies ?? []).length);

    throughput.sent.content = fmtBytes(stats.bytesSent);
    throughput.received.content = fmtBytes(stats.bytesRecv);
    throughput.sentRate.content = fmtRate(Math.max(0, rate.sentRate));
    throughput.receivedRate.content = fmtRate(Math.max(0, rate.recvRate));

    updateChecks(checks, outcomes);
    renderAppPanel(stats);
  }

  render();
  const ticker = setInterval(render, 1000);
  const inputReadyAt = Date.now() + 300;
  void autoManageApp();

  return new Promise<'back'>((resolve) => {
    const finishBack = (): void => {
      clearInterval(ticker);
      renderer.destroy();
      resolve('back');
    };

    renderer.keyInput.on('keypress', async (key) => {
      if (Date.now() < inputReadyAt || actionBusy) return;

      if (isForward && (key.name === 'l' || key.name === 'L') && entry.managedApp) {
        if (previewMode) {
          render();
          return;
        }
        if (!entry.appEntry) return;
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'launch', port: entry.handle.port });
          await launchManagedApp(entry.managedApp, {
            proxyPort: entry.handle.port,
            appPort: entry.appPort,
            label: `app-${entry.appPort ?? entry.handle.port}`,
            cacheTtl: entry.cacheTtl,
            verbose: entry.verbose,
            nodeRegion: entry.nodeRegion,
            nodeDomain: entry.nodeDomain,
            nodeExclude: entry.nodeExclude,
            budget: entry.budget,
            preferNetwork: entry.preferNetwork,
            mode: entry.mode,
            routes: entry.routes,
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

      if (isForward && (key.name === 't' || key.name === 'T')) {
        if (previewMode) {
          render();
          return;
        }
        actionBusy = true;
        try {
          writeTraceLog('proxyDashboard.key', { key: key.name, action: 'test', port: entry.handle.port });
          if (entry.managedApp) {
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
        if (previewMode) {
          clearInterval(ticker);
          renderer.destroy();
          onStop?.();
          resolve('back');
          return;
        }
        clearInterval(ticker);
        const finalStats = entry.handle.stats();
        const endedAt = Date.now();
        const spendUsd = finalStats.spend ?? 0;
        const exhausted = isForward && entry.budget != null && spendUsd >= entry.budget * 0.99;
        saveSession({
          id: sessionId,
          type: isForward ? 'http-proxy' : 'reverse-proxy',
          label: entry.label,
          url: `http://localhost:${entry.handle.port}`,
          target: entry.appPort ? `localhost:${entry.appPort}` : entry.label,
          startedAt: endedAt - finalStats.uptime,
          endedAt,
          durationMs: finalStats.uptime,
          outcome: exhausted ? 'budget-exhausted' : 'user-quit',
          spendUsd,
          requests: finalStats.requests,
          bytesIn: finalStats.bytesRecv,
          bytesOut: finalStats.bytesSent,
          region: entry.nodeRegion,
          nodeDomain: entry.nodeDomain,
          network: entry.preferNetwork,
        });
        if (spendUsd > 0) {
          recordSpend({
            sessionId,
            date: new Date().toISOString().slice(0, 10),
            type: 'proxy',
            amountUsd: spendUsd,
            network: entry.preferNetwork,
          });
        }
        renderer.destroy();
        if (entry.managedApp?.process) await stopManagedApp(entry.managedApp);
        await entry.handle.stop();
        onStop?.();
        resolve('back');
        return;
      }

      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        writeTraceLog('proxyDashboard.key', { key: key.name, ctrl: key.ctrl === true, action: 'back', port: entry.handle.port });
        finishBack();
      }
    });
  });
}
