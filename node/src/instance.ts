import { buildServer } from "./runtime/server";

async function main(): Promise<void> {
  const port = Number(process.env.NODE_PORT || 9090);
  const host = process.env.NODE_HOST || "::";
  const app = await buildServer();

  await app.listen({ port, host });
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
