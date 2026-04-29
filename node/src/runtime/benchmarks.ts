import os from "node:os";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

export async function registerBenchmarkRoutes(app: FastifyInstance): Promise<void> {
  app.post("/benchmark/fetch", async (request, reply) => {
    const body = request.body as { target_url?: string };
    if (!body?.target_url) return reply.code(400).send({ error: "Missing target_url" });

    const start = performance.now();
    const response = await fetch(body.target_url, { signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();

    return {
      success: true,
      status: response.status,
      duration_ms: Math.round(performance.now() - start)
    };
  });

  app.post("/benchmark/cpu", async (request, reply) => {
    const body = request.body as { iterations?: number; data?: string };
    if (!body?.iterations || !body?.data) return reply.code(400).send({ error: "Missing iterations or data" });

    const start = performance.now();
    for (let i = 0; i < body.iterations; i++) {
      crypto.createHash("sha256").update(body.data).digest("hex");
    }
    const durationMs = performance.now() - start;

    return {
      success: true,
      iterations: body.iterations,
      duration_ms: Math.round(durationMs),
      hashes_per_second: Math.round((body.iterations / Math.max(durationMs, 1)) * 1000)
    };
  });

  app.get("/benchmark/system", async () => ({
    success: true,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
    uptime_seconds: os.uptime(),
    bun_version: Bun.version
  }));
}
