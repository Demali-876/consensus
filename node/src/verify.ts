import { integrityPayload } from "./node/integrity";
import { loadConfig } from "./node/state";

async function main(): Promise<void> {
  const serverUrl = process.env.CONSENSUS_SERVER_URL?.trim();
  if (!serverUrl) throw new Error("Missing CONSENSUS_SERVER_URL");

  const config = await loadConfig();
  if (!config.node_id) throw new Error("Missing node_id. Register the node first.");

  const payload = await integrityPayload();
  const response = await fetch(`${trimTrailingSlash(serverUrl)}/node/verify-integrity/${config.node_id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Integrity verification failed: ${JSON.stringify(body)}`);
  }

  console.log(JSON.stringify(body, null, 2));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error("Verify failed:", error);
  process.exit(1);
});
