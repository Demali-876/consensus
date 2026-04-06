// ports.ts — shared local port scanner used by forward-setup, reverse-setup, and tunnels.

import net            from 'net';
import { execSync }   from 'child_process';

export const HTTP_PORTS = [3000, 3001, 3333, 4000, 4200, 5173, 5174, 8000, 8080, 8888, 9000];
export const TCP_PORTS  = [1433, 3306, 5432, 5433, 5672, 6379, 6380, 8086, 9200, 27017];

// Well-known TCP service names for display.
export const PORT_LABELS: Record<number, string> = {
  1433:  'mssql',
  3306:  'mysql',
  5432:  'postgres',
  5433:  'postgres',
  5672:  'rabbitmq',
  6379:  'redis',
  6380:  'redis',
  8086:  'influxdb',
  9200:  'elasticsearch',
  27017: 'mongodb',
};

// Process names we recognise as developer runtimes.
const DEV_PROCESSES = new Set([
  'bun', 'node', 'nodejs', 'deno',
  'python', 'python3', 'python3.9', 'python3.10', 'python3.11', 'python3.12',
  'ruby', 'java', 'php', 'go', 'cargo',
  'uvicorn', 'gunicorn', 'puma', 'unicorn', 'rails',
  'vite', 'webpack', 'parcel', 'esbuild', 'next-server',
]);

export const SPINNER = ['◐', '◓', '◑', '◒'] as const;
export const PROXY_PORT_CANDIDATES = [8080, 8081, 8787, 8888, 9000, 9090] as const;
export const REVERSE_PROXY_PORT_CANDIDATES = [8081, 8080, 8788, 8889, 9001, 9091] as const;

export type ScannedPort = {
  port:      number;
  kind:      'http' | 'tcp';
  label:     string;   // 'bun', 'node', 'postgres', 'redis', etc.
  process:   string;   // raw process name from ps
  isSystem:  boolean;  // true = macOS/system service, not a dev server
};

// Look up the process name owning a listening port via lsof + ps.
function processOnPort(port: number): string {
  try {
    const pid = execSync(
      `lsof -iTCP:${port} -sTCP:LISTEN -n -P -t 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 500 }
    ).trim();
    if (!pid) return '';
    return execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf8', timeout: 500 }).trim();
  } catch { return ''; }
}

function classifyProcess(raw: string): { label: string; isSystem: boolean } {
  // Basename only — strip full path and version suffixes.
  const name = raw.split('/').pop()?.toLowerCase().replace(/[\d.]+$/, '') ?? '';

  if (DEV_PROCESSES.has(name))          return { label: name,     isSystem: false };
  if (name.startsWith('python'))        return { label: 'python',  isSystem: false };
  if (name.startsWith('node'))          return { label: 'node',    isSystem: false };
  if (name.startsWith('bun'))           return { label: 'bun',     isSystem: false };
  if (name.startsWith('deno'))          return { label: 'deno',    isSystem: false };
  if (name.startsWith('java'))          return { label: 'java',    isSystem: false };

  // Anything else is treated as a system service.
  return { label: raw.split('/').pop() ?? raw, isSystem: true };
}

export async function scanPorts(fallbackPorts: number[] = HTTP_PORTS, timeoutMs = 300): Promise<number[]> {
  // ── lsof discovery ─────────────────────────────────────────────────────────
  // Finds every dev server regardless of port number. Falls back to TCP probe.
  try {
    const raw = execSync(
      'lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null',
      { encoding: 'utf8', timeout: 3000 },
    );

    const ports: number[] = [];
    for (const line of raw.split('\n').slice(1)) {
      const cols    = line.trim().split(/\s+/);
      const command = cols[0] ?? '';
      const nameCol = cols[8] ?? '';
      const base    = command.split('/').pop()?.toLowerCase().replace(/[\d.]+$/, '') ?? '';
      const isDev   = DEV_PROCESSES.has(base)
        || base.startsWith('bun')
        || base.startsWith('node')
        || base.startsWith('python')
        || base.startsWith('deno')
        || base.startsWith('java');
      if (!isDev) continue;

      const portStr = nameCol.split(':').pop();
      if (!portStr || portStr === '*') continue;
      const port = parseInt(portStr, 10);
      if (!isNaN(port) && port > 1024 && port < 65535) ports.push(port);
    }

    const unique = [...new Set(ports)].sort((a, b) => a - b);
    if (unique.length > 0) return unique;
  } catch { /* lsof unavailable — fall through */ }

  // ── TCP probe fallback ──────────────────────────────────────────────────────
  const results = await Promise.all(
    fallbackPorts.map(port =>
      new Promise<number | null>(resolve => {
        const sock  = net.createConnection({ host: '127.0.0.1', port });
        const timer = setTimeout(() => { sock.destroy(); resolve(null); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(port); });
        sock.once('error',   () => { clearTimeout(timer); resolve(null); });
      }),
    ),
  );
  return results.filter((p): p is number => p !== null);
}

// Scan HTTP + TCP ports, identify the owning process, filter out system services.
export async function scanAll(): Promise<ScannedPort[]> {
  const [httpFound, tcpFound] = await Promise.all([
    scanPorts(HTTP_PORTS),
    scanPorts(TCP_PORTS),
  ]);

  const allPorts: Array<{ port: number; kind: 'http' | 'tcp' }> = [
    ...httpFound.map(port => ({ port, kind: 'http' as const })),
    ...tcpFound.filter(p => !HTTP_PORTS.includes(p)).map(port => ({ port, kind: 'tcp' as const })),
  ];

  // Deduplicate.
  const seen = new Set<number>();
  const unique = allPorts.filter(p => seen.has(p.port) ? false : (seen.add(p.port), true));

  // Identify each process (done serially — lsof is fast enough).
  const result: ScannedPort[] = [];
  for (const { port, kind } of unique) {
    const raw                  = processOnPort(port);
    const { label, isSystem }  = raw
      ? classifyProcess(raw)
      : { label: PORT_LABELS[port] ?? kind, isSystem: false };

    // For well-known TCP service ports (postgres, redis, etc.) keep them
    // regardless of whether we can identify the process — they are dev-relevant.
    const knownTcpService = PORT_LABELS[port] != null;

    if (!isSystem || knownTcpService) {
      result.push({
        port,
        kind,
        label: knownTcpService && isSystem ? PORT_LABELS[port]! : label,
        process: raw,
        isSystem,
      });
    }
  }

  return result;
}

export function chooseDefaultPort(
  usedPorts: number[],
  candidates: readonly number[],
  fallback: number,
): number {
  const used = new Set(usedPorts);
  return candidates.find((port) => !used.has(port)) ?? fallback;
}
