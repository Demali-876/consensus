import { executeProxyCommand } from "./proxy-command";
import { MESSAGE_TYPE, nowSeconds, type ProxyRequestMessage } from "../tunnel/messages";

export async function executeProxySessionMessage(data: Buffer): Promise<Buffer> {
  let request: {
    id?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  try {
    request = JSON.parse(data.toString("utf8"));
  } catch {
    return jsonBuffer({
      error: "invalid_request",
      message: "Message must be valid JSON",
    });
  }

  if (!request.url) {
    return jsonBuffer({
      id: request.id,
      error: "invalid_request",
      message: "Missing required field: url",
    });
  }

  try {
    const response = await executeProxyCommand({
      type: MESSAGE_TYPE.PROXY_REQUEST,
      id: request.id,
      timestamp: nowSeconds(),
      target_url: request.url,
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
      body_encoding: "utf8",
    } satisfies ProxyRequestMessage);

    const body = response.body_encoding === "base64"
      ? Buffer.from(response.body ?? "", "base64").toString("utf8")
      : response.body ?? "";

    return jsonBuffer({
      id: request.id,
      status: response.status,
      headers: response.headers ?? {},
      body,
      meta: { served_by: "node-control" },
    });
  } catch (error) {
    return jsonBuffer({
      id: request.id,
      error: "fetch_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}
