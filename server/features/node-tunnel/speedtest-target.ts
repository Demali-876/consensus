// The node speed test measures a candidate's real internet-egress capability:
// the orchestrator tells the node which known-size resource to fetch and TIMES
// the round-trip over the eval tunnel (the node self-reports nothing timing-
// authoritative — see runSpeedtestFetch in consensus-node). The server clock,
// not the node, is the measurement.
//
// TARGET (EVAL_SPEEDTEST_URL): a URL template containing "{bytes}", which the
// server substitutes per probe. It defaults to Cloudflare's public download
// endpoint — a real, globally distributed target built for speed testing that
// returns exactly N bytes, no-store. A PUBLIC target is deliberate:
//   1. the node's SSRF guard (correctly) refuses private/internal addresses, so
//      an orchestrator-hosted target that resolves to a private/LAN IP from the
//      node (e.g. a node co-located with the orchestrator) gets blocked;
//   2. now that the data plane is direct (client↔node), a node's GENERAL egress
//      is the relevant metric, not the node↔orchestrator hop.
//
// An orchestrator-hosted target (GET /speedtest/:bytes) is still registered for
// setups that specifically want to measure the node↔orchestrator path — point
// EVAL_SPEEDTEST_URL at it, e.g. https://your-host/speedtest/{bytes}.

// Public, byte-parameterized, no-store, globally distributed via Cloudflare's
// edge. {bytes} is substituted by speedtestUrl().
const DEFAULT_SPEEDTEST_URL = 'https://speed.cloudflare.com/__down?bytes={bytes}';
const MAX_SPEEDTEST_BYTES = 1024 * 1024; // 1 MB ceiling for the orchestrator-hosted route

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

// The configured target template (EVAL_SPEEDTEST_URL) or the Cloudflare default.
export function speedtestUrlTemplate(): string {
  const raw = process.env.EVAL_SPEEDTEST_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SPEEDTEST_URL;
}

// The concrete URL the node is told to fetch for a given size. Substitutes
// {bytes} in the template; a template with no placeholder is treated as a base
// and the byte count is appended (tolerates a plain base URL).
export function speedtestUrl(bytes: number): string {
  const template = speedtestUrlTemplate();
  if (template.includes('{bytes}')) return template.replace(/\{bytes\}/g, String(bytes));
  return `${template.replace(/\/+$/, '')}/${bytes}`;
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
