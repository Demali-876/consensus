import { loadJoinAuthorization } from "./node/state";
import { startEvalClient } from "./clients/eval-client";

async function main(): Promise<void> {
  const gatewayUrl = tunnelUrlFromEnv();
  const connected = await startEvalClient({
    gatewayUrl,
    candidateId: process.env.CONSENSUS_CANDIDATE_ID,
  });

  const joinAuth = await waitForJoinAuthorization();
  connected.client.close(1000, "eval complete");

  console.log("Consensus node eval passed");
  console.log(`join_id=${joinAuth.join_id}`);
  console.log(`expires_at=${joinAuth.expires_at}`);
}

function tunnelUrlFromEnv(): string {
  const explicit = process.env.CONSENSUS_TUNNEL_URL?.trim();
  if (explicit) return explicit;

  const serverUrl = process.env.CONSENSUS_SERVER_URL?.trim();
  if (!serverUrl) {
    throw new Error("Missing CONSENSUS_TUNNEL_URL or CONSENSUS_SERVER_URL");
  }

  const url = new URL(serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/node/tunnel";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForJoinAuthorization() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const joinAuth = await loadJoinAuthorization();
    if (joinAuth && joinAuth.expires_at > Math.floor(Date.now() / 1000)) {
      return joinAuth;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for encrypted join authorization");
}

main().catch((error) => {
  console.error("Eval failed:", error);
  process.exit(1);
});
