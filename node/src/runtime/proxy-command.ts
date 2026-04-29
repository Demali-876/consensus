import type { ProxyRequestMessage, ProxyResponseMessage } from "../tunnel/messages";
import { MESSAGE_TYPE, nowSeconds } from "../tunnel/messages";

export async function executeProxyCommand(message: ProxyRequestMessage): Promise<ProxyResponseMessage> {
  const method = (message.method || "GET").toUpperCase();
  const start = performance.now();
  const body = decodeBody(message.body, message.body_encoding);

  const response = await fetch(message.target_url, {
    method,
    headers: {
      ...(message.headers || {}),
      "user-agent": "Consensus-Node/0.1",
    },
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(30_000),
  });

  const responseBody = Buffer.from(await response.arrayBuffer());

  return {
    type: MESSAGE_TYPE.PROXY_RESPONSE,
    timestamp: nowSeconds(),
    reply_to: message.id ?? "",
    status: response.status,
    status_text: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody.toString("base64"),
    body_encoding: "base64",
  };
}

function decodeBody(body: string | undefined, encoding: "utf8" | "base64" | undefined): string | Buffer | undefined {
  if (body == null) return undefined;
  if (encoding === "base64") return Buffer.from(body, "base64");
  return body;
}
