import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const decoder = new TextDecoder();

const PRELOAD_FILENAME = '.consensus-preload.ts';

type PreloadOpts = {
  cacheTtl?:      number;
  verbose?:       boolean;
  nodeRegion?:    string;
  nodeDomain?:    string;
  nodeExclude?:   string;
  budget?:        number;
  preferNetwork?: string;
  mode?:          'inclusive' | 'exclusive';
  routes?:        string[];
  matchSubroutes?: boolean;
};

function writePreloadFile(cwd: string, opts: PreloadOpts): string {
  const preloadPath = path.join(cwd, PRELOAD_FILENAME);

  const clientOpts: string[] = ['  strategy: "auto",'];
  if (opts.cacheTtl      != null)  clientOpts.push(`  cache_ttl:      ${opts.cacheTtl},`);
  if (opts.verbose)                clientOpts.push(`  verbose:        true,`);
  if (opts.nodeRegion)             clientOpts.push(`  node_region:    "${opts.nodeRegion}",`);
  if (opts.nodeDomain)             clientOpts.push(`  node_domain:    "${opts.nodeDomain}",`);
  if (opts.nodeExclude)            clientOpts.push(`  node_exclude:   "${opts.nodeExclude}",`);
  if (opts.budget        != null)  clientOpts.push(`  limit_usd:      ${opts.budget},`);
  if (opts.mode)                   clientOpts.push(`  mode:           "${opts.mode}",`);
  if (opts.routes?.length)         clientOpts.push(`  routes:         ${JSON.stringify(opts.routes)},`);
  if (opts.matchSubroutes)         clientOpts.push(`  matchSubroutes: true,`);

  const fetchOpts: string[] = [];
  if (opts.preferNetwork) fetchOpts.push(`  preferNetwork: "${opts.preferNetwork}",`);

  const lines = [
    'import { ProxyClient, createPaymentFetch } from "@canister-software/consensus-cli";',
    '',
    // Capture native fetch BEFORE we override globalThis.fetch — used to ship',
    // stats back to the parent worker without recursing through ProxyClient.',
    'const __nativeFetch = globalThis.fetch.bind(globalThis);',
    'const __statsUrl = process.env.CONSENSUS_WORKER_STATS_URL ?? null;',
    '',
    'const paymentFetch = await createPaymentFetch({',
    ...fetchOpts,
    '});',
    '',
    'const client = ProxyClient(paymentFetch, {',
    ...clientOpts,
    '});',
    '',
    'function __targetUrl(input) {',
    '  if (typeof input === "string") return input;',
    '  if (input instanceof URL) return input.toString();',
    '  if (input && typeof input === "object" && "url" in input) return input.url;',
    '  return String(input);',
    '}',
    '',
    'function __reportStats(payload) {',
    '  if (!__statsUrl) return;',
    '  try {',
    '    __nativeFetch(__statsUrl, {',
    '      method: "POST",',
    '      headers: { "content-type": "application/json" },',
    '      body: JSON.stringify(payload),',
    '    }).catch(() => {});',
    '  } catch { /* fire-and-forget */ }',
    '}',
    '',
    'globalThis.fetch = (async (input, init) => {',
    '  const start = performance.now();',
    '  const target = __targetUrl(input);',
    '  try {',
    '    const res = await client.fetch(input, init);',
    '    const lenHdr = res.headers.get("content-length");',
    '    __reportStats({',
    '      ok:        res.ok,',
    '      status:    res.status,',
    '      latencyMs: Math.round(performance.now() - start),',
    '      target,',
    '      bytes:     lenHdr ? parseInt(lenHdr, 10) || 0 : 0,',
    '    });',
    '    return res;',
    '  } catch (err) {',
    '    __reportStats({',
    '      ok:        false,',
    '      status:    0,',
    '      latencyMs: Math.round(performance.now() - start),',
    '      target,',
    '      bytes:     0,',
    '      error:     err && err.message ? err.message : String(err),',
    '    });',
    '    throw err;',
    '  }',
    '}) as typeof fetch;',
  ];
  fs.writeFileSync(preloadPath, lines.join('\n') + '\n', 'utf8');
  return preloadPath;
}

function buildLaunchCommand(entryFile: string, preloadAbsPath: string): string {
  return `bun --preload ${preloadAbsPath} ${entryFile}`;
}

export type AppProbe = {
  at: number;
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  message: string;
};

export type AppState = {
  command?: string;
  checkPath?: string;
  cwd?: string;
  logPath?: string;
  pid?: number;
  launchedAt?: number;
  status: 'disabled' | 'idle' | 'launching' | 'running' | 'exited' | 'error';
  lastExitCode?: number | null;
  lastMessage?: string;
  lastProbe?: AppProbe;
  process?: ReturnType<typeof Bun.spawn>;
  /** Absolute path to the generated preload file. */
  preloadPath?: string;
};

type LaunchAppOptions = {
  proxyPort:       number;
  appPort?:        number;
  label:           string;
  cwd?:            string;
  // Consensus ProxyClient options — serialised into the generated preload file
  cacheTtl?:       number;
  verbose?:        boolean;
  nodeRegion?:     string;
  nodeDomain?:     string;
  nodeExclude?:    string;
  budget?:         number;
  preferNetwork?:  string;
  mode?:           'inclusive' | 'exclusive';
  routes?:         string[];
  matchSubroutes?: boolean;
};

function stamp(): string {
  return new Date().toISOString();
}

function ensureDir(): string {
  const preferred = path.join(os.homedir(), '.consensus');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(process.cwd(), '.consensus');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'app';
}

function append(file: string, line: string): void {
  fs.appendFileSync(file, line, 'utf8');
}

function listListeningPids(port: number): number[] {
  const result = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return [];
  const output = new TextDecoder().decode(result.stdout).trim();
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

async function waitForPortRelease(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listListeningPids(port).length === 0) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for :${port} to stop listening`);
}

async function stopExistingListener(port: number, file: string): Promise<void> {
  const pids = listListeningPids(port);
  if (pids.length === 0) return;

  append(file, `[${stamp()}] reclaim port=:${port} pids=${pids.join(',')}\n`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      append(file, `[${stamp()}] reclaim warning pid=${pid} ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  try {
    await waitForPortRelease(port, 3000);
    return;
  } catch {
    const stubborn = listListeningPids(port);
    if (stubborn.length === 0) return;
    append(file, `[${stamp()}] reclaim escalate port=:${port} pids=${stubborn.join(',')}\n`);
    for (const pid of stubborn) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        append(file, `[${stamp()}] reclaim error pid=${pid} ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    await waitForPortRelease(port, 2000);
  }
}

async function mirror(stream: ReadableStream<Uint8Array> | null | undefined, file: string, label: string): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      append(file, `[${stamp()}] ${label} ${decoder.decode(value)}\n`);
    }
  } catch (err) {
    append(file, `[${stamp()}] ${label}.error ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    reader.releaseLock();
  }
}

function makeLogPath(label: string): string {
  return path.join(ensureDir(), `managed-${sanitize(label)}.log`);
}

function normalizeCheckPath(checkPath?: string): string {
  if (!checkPath || checkPath.trim() === '') return '/';
  return checkPath.startsWith('/') ? checkPath : `/${checkPath}`;
}

export function createAppState(command?: string, checkPath?: string, cwd?: string): AppState {
  return {
    command: command?.trim() || undefined,
    checkPath: normalizeCheckPath(checkPath),
    cwd: cwd?.trim() || process.cwd(),
    status: command?.trim() ? 'idle' : 'disabled',
  };
}

export async function stopManagedApp(state: AppState): Promise<void> {
  if (!state.process) return;
  const proc = state.process;
  state.lastMessage = `stopping pid ${proc.pid}`;
  try {
    proc.kill();
  } catch {
    // Best effort.
  }
  try {
    state.lastExitCode = await proc.exited;
    state.status = 'exited';
    state.lastMessage = `exited with code ${state.lastExitCode}`;
  } catch (err) {
    state.status = 'error';
    state.lastMessage = err instanceof Error ? err.message : String(err);
  } finally {
    state.process = undefined;
    state.pid = undefined;
  }
}

export async function launchManagedApp(
  state: AppState,
  opts: LaunchAppOptions,
): Promise<void> {
  if (!state.command) throw new Error('No entry file configured');

  const logPath  = makeLogPath(opts.label);
  const appCwd   = opts.cwd ?? state.cwd ?? process.cwd();

  state.status      = 'launching';
  state.logPath     = logPath;
  state.lastMessage = 'launching app';

  if (state.process) await stopManagedApp(state);
  if (opts.appPort) await stopExistingListener(opts.appPort, logPath);

  const preloadPath   = writePreloadFile(appCwd, opts);
  state.preloadPath   = preloadPath;
  const launchCommand = buildLaunchCommand(state.command, preloadPath);

  append(logPath, `\n[${stamp()}] launch command=${launchCommand} cwd=${appCwd}\n`);
  append(logPath, `[${stamp()}] preload written=${preloadPath}\n`);

  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  // Side-channel: the preload fires-and-forgets a tiny POST to this URL after
  // every fetch so the parent worker's dashboard counters reflect real traffic
  // even though the actual /proxy request goes direct to the Consensus server.
  if (opts.proxyPort) {
    childEnv.CONSENSUS_WORKER_STATS_URL = `http://localhost:${opts.proxyPort}/_consensus/stats`;
  }
  const proc = Bun.spawn([process.env.SHELL ?? 'zsh', '-lc', launchCommand], {
    cwd: appCwd,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  state.process = proc;
  state.pid = proc.pid;
  state.launchedAt = Date.now();
  state.status = 'running';
  state.lastExitCode = undefined;
  state.lastMessage = `running pid ${proc.pid}`;

  void mirror(proc.stdout, logPath, 'stdout');
  void mirror(proc.stderr, logPath, 'stderr');
  void proc.exited.then((code) => {
    state.lastExitCode = code;
    state.status = 'exited';
    state.lastMessage = `exited with code ${code}`;
    state.process = undefined;
    state.pid = undefined;
    append(logPath, `[${stamp()}] exit code=${code}\n`);
  }).catch((err) => {
    state.status = 'error';
    state.lastMessage = err instanceof Error ? err.message : String(err);
    state.process = undefined;
    state.pid = undefined;
    append(logPath, `[${stamp()}] exit.error ${state.lastMessage}\n`);
  });
}

export async function probeManagedApp(
  state: AppState,
  opts: { appPort?: number; checkPath?: string },
): Promise<AppProbe> {
  if (!opts.appPort) throw new Error('No app port configured for probing');
  const pathName = normalizeCheckPath(opts.checkPath ?? state.checkPath);
  const url = `http://127.0.0.1:${opts.appPort}${pathName}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const probe: AppProbe = {
      at: Date.now(),
      ok: true,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      message: `${response.status} ${response.statusText || 'response'} @ ${pathName}`,
    };
    state.lastProbe = probe;
    return probe;
  } catch (err) {
    const probe: AppProbe = {
      at: Date.now(),
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : String(err),
    };
    state.lastProbe = probe;
    return probe;
  }
}

export async function probeManagedAppUntilReady(
  state: AppState,
  opts: { appPort?: number; checkPath?: string; attempts?: number; intervalMs?: number },
): Promise<AppProbe> {
  const attempts = Math.max(opts.attempts ?? 6, 1);
  const intervalMs = Math.max(opts.intervalMs ?? 1000, 100);

  let lastProbe: AppProbe | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    lastProbe = await probeManagedApp(state, opts);
    if (lastProbe.ok) return lastProbe;
    if (attempt < attempts - 1) {
      await Bun.sleep(intervalMs);
    }
  }

  return lastProbe ?? {
    at: Date.now(),
    ok: false,
    message: 'probe did not run',
  };
}
