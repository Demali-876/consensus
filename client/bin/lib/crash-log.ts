import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function ensureCrashDir(): string {
  const dir = path.join(os.homedir(), '.consensus');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  return new Date().toISOString();
}

function processLogPath(): string {
  return path.join(ensureCrashDir(), 'cli-process.log');
}

function appendLine(file: string, line: string): void {
  fs.appendFileSync(file, line, 'utf8');
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  return String(err);
}

export function installProcessLogCapture(): string {
  const file = processLogPath();
  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;

  let mirrorActive = false;
  const mirror = (channel: 'stdout' | 'stderr', chunk: unknown): void => {
    if (mirrorActive) return;
    mirrorActive = true;
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      appendLine(file, `[${stamp()}] ${channel} ${JSON.stringify(text)}\n`);
    } catch {
      // Best effort only.
    } finally {
      mirrorActive = false;
    }
  };

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    mirror('stdout', chunk);
    return originalStdoutWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    mirror('stderr', chunk);
    return originalStderrWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;

  const wrapConsoleMethod = (name: 'log' | 'info' | 'warn' | 'error' | 'debug') => {
    const original = console[name].bind(console);
    console[name] = ((...args: unknown[]) => {
      try {
        appendLine(file, `[${stamp()}] console.${name} ${args.map((arg) => (
          typeof arg === 'string' ? arg : formatError(arg)
        )).join(' ')}\n`);
      } catch {
        // Best effort only.
      }
      return original(...args);
    }) as typeof console[typeof name];
  };

  wrapConsoleMethod('log');
  wrapConsoleMethod('info');
  wrapConsoleMethod('warn');
  wrapConsoleMethod('error');
  wrapConsoleMethod('debug');

  appendLine(file, `\n[${stamp()}] process.start cwd=${process.cwd()} argv=${JSON.stringify(process.argv)}\n`);
  process.on('exit', (code) => appendLine(file, `[${stamp()}] process.exit code=${code}\n`));
  process.on('beforeExit', (code) => appendLine(file, `[${stamp()}] process.beforeExit code=${code}\n`));
  process.on('SIGINT', () => appendLine(file, `[${stamp()}] signal SIGINT\n`));
  process.on('SIGTERM', () => appendLine(file, `[${stamp()}] signal SIGTERM\n`));

  return file;
}

export function writeCrashLog(context: string, err: unknown, extra?: Record<string, unknown>): string {
  const dir = ensureCrashDir();
  const file = path.join(dir, 'cli-crash.log');
  const lines = [
    `[${stamp()}] ${context}`,
    `cwd: ${process.cwd()}`,
    `argv: ${JSON.stringify(process.argv)}`,
    ...(extra ? [`extra: ${JSON.stringify(extra)}`] : []),
    formatError(err),
    '',
  ];
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

export function writeTraceLog(context: string, extra?: Record<string, unknown>): string {
  const dir = ensureCrashDir();
  const file = path.join(dir, 'cli-trace.log');
  const line = `[${stamp()}] ${context}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return file;
}

export function getProcessLogPath(): string {
  return processLogPath();
}
