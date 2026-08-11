import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  assertProxyProfileRequestV1,
  hashProxyProfileV1,
  normalizeProxyProfileV1,
} from '../../features/proxy/profile-v1.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../../features/proxy/test-vectors/profile-v1.vectors.json'), 'utf8')) as {
  vectors: Array<{ input: unknown; normalized: unknown; hash: string }>;
};

describe('profile-v1 shared contract', () => {
  it('matches every canonicalization and hash vector', () => {
    for (const vector of fixture.vectors) {
      assert.deepEqual(normalizeProxyProfileV1(vector.input), vector.normalized);
      assert.equal(hashProxyProfileV1(vector.input), vector.hash);
    }
  });

  it('enforces the profile again at the server boundary', () => {
    const profile = fixture.vectors[0].normalized;
    assert.doesNotThrow(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/v1/search', 'HEAD'));
    assert.throws(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/v1/private', 'GET'), /not allowed/);
  });
});
