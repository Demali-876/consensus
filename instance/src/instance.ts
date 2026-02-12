import Fastify from "fastify";
import fs from "node:fs/promises";
import path from "node:path";

async function readVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), "VERSION"), "utf8");
    return raw.trim();
  } catch {
    return process.env.CONSENSUS_VERSION || "dev";
  }
}

async function main() {
  const version = await readVersion();
  const port = Number(process.env.NODE_PORT || 9090);

  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return {
      status: "healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  });

  app.get("/version", async () => {
    return {
      product: "consensus-node",
      version,
      node: process.version
    };
  });

  await app.listen({
    port,
    host: "::"
  });

  app.log.info(`Consensus Node ${version} listening on http://[::]:${port}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
