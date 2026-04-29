import { startControlClient } from "./clients/control-client";

async function main(): Promise<void> {
  const gatewayUrl = tunnelUrlFromEnv();
  let attempt = 0;

  while (true) {
    try {
      const connected = await startControlClient({ gatewayUrl });
      attempt = 0;

      console.log("Consensus node control tunnel connected");
      console.log(`node_id=${connected.nodeId}`);
      console.log(`session_id=${connected.sessionId}`);

      const close = await connected.closed;
      console.error(`Control tunnel closed: ${close.reason ?? close.error.message}`);
    } catch (error) {
      console.error("Control tunnel failed:", error);
    }

    attempt += 1;
    const delayMs = reconnectDelayMs(attempt);
    console.error(`Reconnecting control tunnel in ${Math.round(delayMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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

function reconnectDelayMs(attempt: number): number {
  const capped = Math.min(attempt, 6);
  const base = Math.min(30_000, 1_000 * 2 ** (capped - 1));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

main().catch((error) => {
  console.error("Control tunnel failed:", error);
  process.exit(1);
});
