import os from "node:os";
import crypto from "node:crypto";
import { capabilitiesRecord } from "./capabilities";
import { integrityPayload } from "../node/integrity";
import type { EvalAction } from "../tunnel/messages";

export async function runEvalAction(action: EvalAction, params: Record<string, unknown> = {}): Promise<unknown> {
  if (action === "capabilities") return capabilitiesRecord();
  if (action === "integrity") return integrityPayload();
  if (action === "benchmark_system") return systemBenchmark();
  if (action === "benchmark_cpu") return cpuBenchmark(params);
  throw new Error(`Unsupported eval action: ${action}`);
}

function systemBenchmark() {
  return {
    success: true,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
    uptime_seconds: os.uptime(),
    bun_version: Bun.version,
  };
}

function cpuBenchmark(params: Record<string, unknown>) {
  const iterations = integerParam(params.iterations, 5_000, 1, 200_000);
  const data = typeof params.data === "string" && params.data.length > 0
    ? params.data
    : "consensus-node-eval";

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    crypto.createHash("sha256").update(data).digest("hex");
  }
  const durationMs = performance.now() - start;

  return {
    success: true,
    iterations,
    duration_ms: Math.round(durationMs),
    hashes_per_second: Math.round((iterations / Math.max(durationMs, 1)) * 1000),
  };
}

function integerParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
