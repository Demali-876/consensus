import { FRAME_TYPE, type FrameType } from "./frames";
import {
  MESSAGE_TYPE,
  createErrorMessage,
  decodeMessage,
  encodeMessage,
  nowSeconds,
  type PingMessage,
  type PongMessage,
  type TunnelMessage,
} from "./messages";
import { openFrame, sealFrame, type SecureSession } from "../crypto/secure-channel";

export interface TunnelClientOptions {
  url: string;
  socket?: WebSocket;
  session: SecureSession;
  mode: "eval" | "control";
  nodeId?: string;
  candidateId?: string;
  version?: string;
  publicKeyPem?: string;
  requestTimeoutMs?: number;
}

export type TunnelMessageHandler = (message: TunnelMessage, client: TunnelClient) => void | Promise<void>;
export type TunnelCloseHandler = (event: { code?: number; reason?: string; error: Error }) => void;

interface PendingRequest {
  resolve: (message: TunnelMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private sendSequence = 0n;
  private lastReceiveSequence = -1n;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Set<TunnelMessageHandler>();
  private readonly closeHandlers = new Set<TunnelCloseHandler>();
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: TunnelClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  onMessage(handler: TunnelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: TunnelCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const ws = this.options.socket ?? new WebSocket(this.options.url);
    this.ws = ws;

    if (ws.readyState !== WebSocket.OPEN) {
      await waitForOpen(ws, this.options.url);
    }

    ws.addEventListener("message", (event) => {
      void this.handleRawMessage(event.data).catch((error) => {
        void this.send(createErrorMessage({
          code: "decode_failed",
          message: error instanceof Error ? error.message : String(error),
        })).catch(() => undefined);
      });
    });

    ws.addEventListener("close", (event) => {
      const code = "code" in event && typeof event.code === "number" ? event.code : undefined;
      const reason = "reason" in event && typeof event.reason === "string" ? event.reason : "closed";
      this.handleClose(new Error(`Tunnel connection closed: ${reason}`), code, reason);
    });

    await this.send({
      type: MESSAGE_TYPE.HELLO,
      timestamp: nowSeconds(),
      mode: this.options.mode,
      node_id: this.options.nodeId,
      candidate_id: this.options.candidateId,
      public_key_pem: this.options.publicKeyPem,
      version: this.options.version,
    });
  }

  close(code = 1000, reason = "closed"): void {
    this.rejectAll(new Error(`Tunnel closed: ${reason}`));
    this.ws?.close(code, reason);
    this.ws = null;
  }

  async send(message: TunnelMessage, frameType: FrameType = FRAME_TYPE.DATA): Promise<void> {
    const ws = this.requireOpenSocket();
    const payload = encodeMessage(message);
    const raw = sealFrame(this.options.session.sendKey, frameType, this.nextSequence(), payload);
    ws.send(raw);
  }

  async request(message: TunnelMessage): Promise<TunnelMessage> {
    const id = message.id ?? crypto.randomUUID();
    const requestMessage = { ...message, id } as TunnelMessage;

    const result = new Promise<TunnelMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tunnel request timed out: ${id}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    await this.send(requestMessage);
    return result;
  }

  private async handleRawMessage(data: unknown): Promise<void> {
    const raw = await toBuffer(data);
    const { frame, plaintext } = openFrame(this.options.session.receiveKey, raw);

    if (frame.sequence <= this.lastReceiveSequence) {
      throw new Error("Replay or out-of-order tunnel frame rejected");
    }
    this.lastReceiveSequence = frame.sequence;

    if (frame.type === FRAME_TYPE.PING) {
      await this.send(pongMessage(), FRAME_TYPE.PONG);
      return;
    }

    if (frame.type === FRAME_TYPE.PONG) return;
    if (frame.type === FRAME_TYPE.CLOSE) {
      this.close(1000, "remote close");
      return;
    }

    const message = decodeMessage(plaintext);
    this.resolvePending(message);

    for (const handler of this.handlers) {
      await handler(message, this);
    }
  }

  private resolvePending(message: TunnelMessage): void {
    const replyTo = "reply_to" in message ? message.reply_to : undefined;
    if (!replyTo || typeof replyTo !== "string") return;

    const pending = this.pending.get(replyTo);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(replyTo);

    if (message.type === MESSAGE_TYPE.ERROR) {
      pending.reject(new Error(message.message));
    } else {
      pending.resolve(message);
    }
  }

  private nextSequence(): bigint {
    const sequence = this.sendSequence;
    this.sendSequence += 1n;
    return sequence;
  }

  private requireOpenSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Tunnel is not connected");
    }
    return this.ws;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleClose(error: Error, code?: number, reason?: string): void {
    this.rejectAll(error);
    this.ws = null;
    for (const handler of this.closeHandlers) {
      handler({ code, reason, error });
    }
  }
}

function pongMessage(): PongMessage {
  return {
    type: MESSAGE_TYPE.PONG,
    timestamp: nowSeconds(),
  };
}

export function pingMessage(): PingMessage {
  return {
    type: MESSAGE_TYPE.PING,
    timestamp: nowSeconds(),
    id: crypto.randomUUID(),
  };
}

function waitForOpen(ws: WebSocket, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Tunnel connection failed: ${url}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

async function toBuffer(data: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (typeof data === "string") return Buffer.from(data, "base64");
  throw new TypeError(`Unsupported WebSocket message payload: ${typeof data}`);
}
