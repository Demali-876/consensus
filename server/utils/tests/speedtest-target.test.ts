import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSpeedtestTarget, speedtestUrl, speedtestBaseUrl, MAX_SPEEDTEST_BYTES } from '../../features/node-tunnel/speedtest-target.ts';

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

test('speedtestUrl builds against the configured base, trimming slashes', () => {
  const prev = process.env.EVAL_SPEEDTEST_BASE_URL;
  try {
    process.env.EVAL_SPEEDTEST_BASE_URL = 'https://orch.example.com/';
    assert.equal(speedtestBaseUrl(), 'https://orch.example.com');
    assert.equal(speedtestUrl(16384), 'https://orch.example.com/speedtest/16384');

    delete process.env.EVAL_SPEEDTEST_BASE_URL;
    assert.match(speedtestUrl(1024), /^https:\/\/.+\/speedtest\/1024$/, 'falls back to a default host');
  } finally {
    if (prev === undefined) delete process.env.EVAL_SPEEDTEST_BASE_URL;
    else process.env.EVAL_SPEEDTEST_BASE_URL = prev;
  }
});
