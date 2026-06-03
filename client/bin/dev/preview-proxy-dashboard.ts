#!/usr/bin/env bun

import { showProxyDashboard } from '../tui/screens/proxy/dashboard.js';
import type { AppState } from '../lib/app-manager.js';
import type { WorkerEntry } from '../tui/screens/proxy/hub.js';
import type { ProxyWorkerHandle, WorkerStats } from '../../src/proxy-worker.js';

type PreviewMode = 'forward' | 'reverse';

function makePreviewHandle(type: PreviewMode): ProxyWorkerHandle {
  const startedAt = Date.now() - 42 * 60_000;
  const seedLatencies = [
    68, 72, 61, 74, 80, 65, 59, 63, 69, 71,
    66, 64, 78, 91, 84, 77, 72, 69, 74, 81,
    86, 92, 88, 79, 75, 73, 71, 69, 70, 76,
    82, 88, 74, 70, 66, 72, 78, 84, 90, 73,
  ];
  const seedOutcomes = Array.from({ length: 40 }, (_, i) => i !== 12 && i !== 29 && i !== 36);

  return {
    type,
    port: type === 'forward' ? 8080 : 8081,
    stop: async () => {},
    stats: (): WorkerStats => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      const tick = Math.floor(elapsedSec / 2);
      const recentLatencies = seedLatencies.map((v, i) => v + (((tick + i) % 9) - 4) * 3);
      if (tick % 17 === 0) recentLatencies[10] = type === 'reverse' ? 280 : 180;
      if (tick % 23 === 0) recentLatencies[28] = type === 'reverse' ? 310 : 210;
      const recentOutcomes = seedOutcomes.map((ok, i) => ((tick + i) % 31 === 0 ? false : ok));
      const sorted = [...recentLatencies].sort((a, b) => a - b);
      const avg = recentLatencies.reduce((sum, n) => sum + n, 0) / recentLatencies.length;
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;

      return {
        requests: (type === 'forward' ? 1260 : 1370) + Math.floor(elapsedSec / 4),
        cacheHits: type === 'reverse' ? 312 + Math.floor(elapsedSec / 10) : undefined,
        bytesSent: (type === 'forward' ? 8_620_000 : 8_930_000) + elapsedSec * 4_200,
        bytesRecv: (type === 'forward' ? 43_270_000 : 45_410_000) + elapsedSec * 92_000,
        uptime: Date.now() - startedAt,
        spend: 0.025138 + elapsedSec * 0.000001,
        currentLatencyMs: recentLatencies.at(-1),
        avgLatencyMs: avg,
        p95LatencyMs: p95,
        recentLatencies,
        recentOutcomes,
        lastStatusCode: type === 'reverse' && tick % 19 === 0 ? 304 : 200,
      };
    },
  };
}

function makePreviewAppState(): AppState {
  return {
    command: '~/code/my-api/server.ts',
    checkPath: '/healthz',
    cwd: process.cwd(),
    pid: 4821,
    launchedAt: Date.now() - 42 * 60_000,
    status: 'running',
    lastMessage: 'ready',
    lastProbe: {
      at: Date.now() - 2000,
      ok: true,
      latencyMs: 31,
      statusCode: 200,
      message: '200 /healthz',
    },
    preloadPath: '.consensus-preload.ts',
  };
}

function buildPreviewEntry(mode: PreviewMode, freeMode: boolean): WorkerEntry {
  const handle = makePreviewHandle(mode);
  if (mode === 'reverse') {
    return {
      handle,
      startedAt: Date.now(),
      label: 'localhost:3000',
      budget: freeMode ? undefined : 5,
      cacheTtl: 30_000,
      preferNetwork: 'eip155:84532',
    };
  }

  return {
    handle,
    startedAt: Date.now(),
    label: 'app :3000 -> consensus - preload',
    budget: freeMode ? undefined : 5,
    appPort: 3000,
    appEntry: '~/code/my-api/server.ts',
    appCheckPath: '/healthz',
    autoLaunch: true,
    cacheTtl: 300,
    nodeRegion: 'us-west-1',
    preferNetwork: 'eip155:84532',
    mode: 'inclusive',
    routes: ['/api', '/v2'],
    matchSubroutes: true,
    managedApp: makePreviewAppState(),
  };
}

const args = process.argv.slice(2);
const mode = args.includes('reverse') ? 'reverse' : 'forward';
const freeMode = args.includes('--free') || !args.includes('--paid');

if (!freeMode && !process.env.CONSENSUS_BALANCE_USD) {
  process.env.CONSENSUS_BALANCE_USD = '24.18';
}

await showProxyDashboard(buildPreviewEntry(mode, freeMode), undefined, {
  freeMode,
  preview: true,
});
