import type { FastifyInstance } from "fastify";

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/proxy", async (request, reply) => {
    const body = request.body as {
      target_url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };

    if (!body?.target_url) return reply.code(400).send({ error: "Missing target_url" });

    const method = (body.method || "GET").toUpperCase();
    const start = performance.now();
    const response = await fetch(body.target_url, {
      method,
      headers: {
        ...(body.headers || {}),
        "user-agent": "Consensus-Node/0.1"
      },
      body: method === "GET" || method === "HEAD"
        ? undefined
        : typeof body.body === "string"
          ? body.body
          : JSON.stringify(body.body ?? null),
      signal: AbortSignal.timeout(30_000)
    });

    const responseText = await response.text();

    return reply.code(response.status).send({
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: responseText,
      meta: {
        processing_ms: Math.round(performance.now() - start),
        timestamp: new Date().toISOString()
      }
    });
  });
}
