// Orchestrator-hosted target for the node speed test. A candidate node fetches
// `GET /speedtest/:bytes` through its real SSRF-guarded serve path while the
// orchestrator times the round-trip over the eval tunnel — so the target is
// known-size, orchestrator-controlled, and can't be gamed (the node reports
// nothing; the server clocks it). Caching is disabled so an intermediary can't
// skew the measurement.
//
// The base URL the node is told to fetch is `EVAL_SPEEDTEST_BASE_URL` (defaults
// to the public orchestrator host). In an environment where that host is not
// reachable from the node, the speed battery self-skips after a warmup probe —
// see runNetworkEval in node-tunnel.ts.

const DEFAULT_BASE_URL = 'https://consensus.canister.software';
const MAX_SPEEDTEST_BYTES = 1024 * 1024; // 1 MB ceiling per request

// Minimal shape of what we use from the Express app/handlers — avoids taking a
// hard dependency on @types/express in this .ts module (mirrors the loosely
// typed style in orchestrator.js).
interface RouteRequest {
  params: { bytes?: string };
}
interface RouteResponse {
  status(code: number): RouteResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(chunk: Buffer): void;
}
interface RouteApp {
  get(path: string, handler: (req: RouteRequest, res: RouteResponse) => void): void;
}

export function speedtestBaseUrl(): string {
  const raw = process.env.EVAL_SPEEDTEST_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function speedtestUrl(bytes: number): string {
  return `${speedtestBaseUrl()}/speedtest/${bytes}`;
}

export function registerSpeedtestTarget(app: RouteApp): void {
  app.get('/speedtest/:bytes', (req, res) => {
    const requested = Number(req.params.bytes);
    if (!Number.isInteger(requested) || requested < 0 || requested > MAX_SPEEDTEST_BYTES) {
      res.status(400).json({ error: `bytes must be an integer 0-${MAX_SPEEDTEST_BYTES}` });
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-consensus-speedtest', '1');
    res.end(Buffer.alloc(requested, 0x61));
  });
}

export { MAX_SPEEDTEST_BYTES };
