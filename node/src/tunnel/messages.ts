export const TUNNEL_MODE = {
  EVAL:    "eval",
  CONTROL: "control",
} as const;

export type TunnelMode = typeof TUNNEL_MODE[keyof typeof TUNNEL_MODE];

export const MESSAGE_TYPE = {
  HELLO:          "hello",
  READY:          "ready",
  PING:           "ping",
  PONG:           "pong",
  HTTP_REQUEST:   "http_request",
  HTTP_RESPONSE:  "http_response",
  EVAL_REQUEST:   "eval_request",
  EVAL_RESPONSE:  "eval_response",
  JOIN_READY:     "join_ready",
  HEARTBEAT:      "heartbeat",
  PROXY_REQUEST:  "proxy_request",
  PROXY_RESPONSE: "proxy_response",
  STREAM_OPEN:    "stream_open",
  STREAM_DATA:    "stream_data",
  STREAM_CLOSE:   "stream_close",
  ACK:            "ack",
  ERROR:          "error",
} as const;

export type MessageType = typeof MESSAGE_TYPE[keyof typeof MESSAGE_TYPE];

export interface BaseMessage {
  type: MessageType;
  id?: string;
  timestamp: number;
}

export interface HelloMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.HELLO;
  mode: TunnelMode;
  node_id?: string;
  candidate_id?: string;
  public_key_pem?: string;
  version?: string;
}

export interface ReadyMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.READY;
  session_id: string;
  mode: TunnelMode;
}

export interface PingMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.PING;
}

export interface PongMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.PONG;
  reply_to?: string;
}

export interface HttpRequestMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.HTTP_REQUEST;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  body_encoding?: "utf8" | "base64";
}

export interface HttpResponseMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.HTTP_RESPONSE;
  reply_to: string;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  body_encoding?: "utf8" | "base64";
}

export type EvalAction =
  | "capabilities"
  | "integrity"
  | "benchmark_system"
  | "benchmark_cpu";

export interface EvalRequestMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.EVAL_REQUEST;
  action: EvalAction;
  params?: Record<string, unknown>;
}

export interface EvalResponseMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.EVAL_RESPONSE;
  reply_to: string;
  action: EvalAction;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface JoinReadyMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.JOIN_READY;
  join_id: string;
  alg: "ed25519";
  nonce: string;
  expires_at: number;
}

export interface HeartbeatMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.HEARTBEAT;
  node_id: string;
  uptime_seconds: number;
  capabilities: Record<string, boolean>;
  active_requests?: number;
  active_streams?: number;
}

export interface ProxyRequestMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.PROXY_REQUEST;
  target_url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  body_encoding?: "utf8" | "base64";
}

export interface ProxyResponseMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.PROXY_RESPONSE;
  reply_to: string;
  status: number;
  status_text?: string;
  headers?: Record<string, string>;
  body?: string;
  body_encoding?: "utf8" | "base64";
}

export interface StreamOpenMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.STREAM_OPEN;
  stream_id: string;
  target?: string;
}

export interface StreamDataMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.STREAM_DATA;
  stream_id: string;
  data: string;
  encoding: "base64";
}

export interface StreamCloseMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.STREAM_CLOSE;
  stream_id: string;
  reason?: string;
}

export interface AckMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.ACK;
  reply_to: string;
}

export interface ErrorMessage extends BaseMessage {
  type: typeof MESSAGE_TYPE.ERROR;
  reply_to?: string;
  code: string;
  message: string;
}

export type TunnelMessage =
  | HelloMessage
  | ReadyMessage
  | PingMessage
  | PongMessage
  | HttpRequestMessage
  | HttpResponseMessage
  | EvalRequestMessage
  | EvalResponseMessage
  | JoinReadyMessage
  | HeartbeatMessage
  | ProxyRequestMessage
  | ProxyResponseMessage
  | StreamOpenMessage
  | StreamDataMessage
  | StreamCloseMessage
  | AckMessage
  | ErrorMessage;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function encodeMessage(message: TunnelMessage): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

export function decodeMessage(payload: Buffer): TunnelMessage {
  const parsed = JSON.parse(payload.toString("utf8")) as unknown;
  assertTunnelMessage(parsed);
  return parsed;
}

export function assertTunnelMessage(value: unknown): asserts value is TunnelMessage {
  if (!value || typeof value !== "object") {
    throw new TypeError("Tunnel message must be an object");
  }

  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") {
    throw new TypeError("Tunnel message type is required");
  }

  if (!Object.values(MESSAGE_TYPE).includes(message.type as MessageType)) {
    throw new TypeError(`Unknown tunnel message type: ${message.type}`);
  }

  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    throw new TypeError("Tunnel message timestamp must be a finite number");
  }
}

export function createErrorMessage(input: {
  reply_to?: string;
  code: string;
  message: string;
}): ErrorMessage {
  return {
    type: MESSAGE_TYPE.ERROR,
    timestamp: nowSeconds(),
    reply_to: input.reply_to,
    code: input.code,
    message: input.message,
  };
}
