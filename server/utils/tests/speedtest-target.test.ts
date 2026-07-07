import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSpeedtestTarget, speedtestUrl, MAX_SPEEDTEST_BYTES } from '../../features/node-tunnel/speedtest-target.ts';

// Capture the handler registered on GET /speedtest/:bytes without a live server.
function captureHandler() {
  let handler;
  registerSpeedtestTarget({
    get(path, fn) {
      assert.equal(path, '/speedtest/:bytes');
      handler = fn;
    },
  });
  assert.ok(handler, 'route handler registered');
  return handler;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    jsonBody: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk) { this.body = chunk; },
  };
  return res;
}

test('serves exactly the requested number of bytes with caching disabled', () => {
  const handler = captureHandler();
  const res = mockRes();
  handler({ params: { bytes: '16384' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Buffer.isBuffer(res.body), 'body is a Buffer');
  assert.equal(res.body.length, 16384, 'exact byte count');
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['cache-control'], 'no-store', 'no caching to skew the measurement');
  assert.equal(res.headers['x-consensus-speedtest'], '1');
});

test('zero bytes is valid (a latency-only probe)', () => {
  const res = mockRes();
  captureHandler()({ params: { bytes: '0' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 0);
});

test('rejects non-integer, negative, and over-cap sizes', () => {
  const handler = captureHandler();
  for (const bad of ['abc', '-1', String(MAX_SPEEDTEST_BYTES + 1), '1.5']) {
    const res = mockRes();
    handler({ params: { bytes: bad } }, res);
    assert.equal(res.statusCode, 400, `"${bad}" rejected`);
    assert.ok(res.jsonBody?.error, 'error message present');
    assert.equal(res.body, undefined, 'no payload on rejection');
  }
});

test('speedtestUrl defaults to the public Cloudflare target with {bytes} substituted', () => {
  const prev = process.env.EVAL_SPEEDTEST_URL;
  try {
    delete process.env.EVAL_SPEEDTEST_URL;
    // Public target: resolves to public IPs, so the node's SSRF guard allows it.
    assert.equal(speedtestUrl(16384), 'https://speed.cloudflare.com/__down?bytes=16384');
  } finally {
    if (prev === undefined) delete process.env.EVAL_SPEEDTEST_URL;
    else process.env.EVAL_SPEEDTEST_URL = prev;
  }
});

test('speedtestUrl honors EVAL_SPEEDTEST_URL — a {bytes} template or a plain base', () => {
  const prev = process.env.EVAL_SPEEDTEST_URL;
  try {
    process.env.EVAL_SPEEDTEST_URL = 'https://speed.example.com/dl?bytes={bytes}';
    assert.equal(speedtestUrl(1024), 'https://speed.example.com/dl?bytes=1024');

    // A base with no placeholder (e.g. an orchestrator-hosted target) gets the
    // byte count appended, trimming a trailing slash.
    process.env.EVAL_SPEEDTEST_URL = 'https://orch.example.com/speedtest/';
    assert.equal(speedtestUrl(2048), 'https://orch.example.com/speedtest/2048');
  } finally {
    if (prev === undefined) delete process.env.EVAL_SPEEDTEST_URL;
    else process.env.EVAL_SPEEDTEST_URL = prev;
  }
});
