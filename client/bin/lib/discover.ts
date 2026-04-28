import { execSync }          from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';

export type DiscoveredProcess = {
  pid:       number;
  port:      number;
  service:   string;
  entryFile: string | null;
};

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout:  2000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function getPidForPort(port: number): number | null {
  const out = run(`lsof -i :${port} -n -P -t -sTCP:LISTEN`);
  const pid = parseInt(out.split('\n')[0] ?? '', 10);
  return isNaN(pid) ? null : pid;
}

function getCommandLine(pid: number): string {
  return run(`ps -p ${pid} -o args=`);
}

function getProcessCwd(pid: number): string {
  // macOS
  const mac = run(`lsof -p ${pid} 2>/dev/null | awk '$4 == "cwd" {print $NF}'`);
  if (mac) return mac;
  // Linux
  return run(`readlink /proc/${pid}/cwd`);
}

function parseCommand(cmd: string): { service: string; rawEntry: string | null } {
  const parts      = cmd.trim().split(/\s+/);
  const binaryBase = (parts[0] ?? '').split('/').pop() ?? '';

  let service = 'unknown';
  if (/bun/i.test(binaryBase))   service = 'bun';
  else if (/node/i.test(binaryBase)) service = 'node';
  else if (/deno/i.test(binaryBase)) service = 'deno';
  else if (/tsx/i.test(binaryBase))  service = 'tsx';

  const SKIP = new Set(['run', 'exec', 'start', 'dev', 'x', '--smol', '--hot']);
  let rawEntry: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith('-') || SKIP.has(p) || p.includes('=')) continue;
    if (/\.(ts|js|mjs|cjs|tsx|jsx)$/.test(p)) { rawEntry = p; break; }
    if (p.includes('/') && !p.startsWith('-'))  { rawEntry = p; break; }
  }

  return { service, rawEntry };
}

export async function discoverProcess(port: number): Promise<DiscoveredProcess | null> {
  try {
    const pid = getPidForPort(port);
    if (!pid) return null;

    const cmd = getCommandLine(pid);
    if (!cmd) return { pid, port, service: 'unknown', entryFile: null };

    const { service, rawEntry } = parseCommand(cmd);

    let entryFile: string | null = null;
    if (rawEntry) {
      if (isAbsolute(rawEntry)) {
        entryFile = rawEntry;
      } else {
        const cwd = getProcessCwd(pid) || process.cwd();
        entryFile = resolve(cwd, rawEntry);
      }
    }

    return { pid, port, service, entryFile };
  } catch {
    return null;
  }
}

export async function discoverAll(ports: number[]): Promise<DiscoveredProcess[]> {
  const results = await Promise.all(ports.map(p => discoverProcess(p)));
  return results.filter((r): r is DiscoveredProcess => r !== null);
}
