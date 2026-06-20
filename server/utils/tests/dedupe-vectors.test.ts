import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { generateDedupeKey, type DedupeParams } from '../../features/proxy/dedupe.ts';

interface Vector {
  name: string;
  input: DedupeParams;
  key: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, '../../features/proxy/test-vectors/dedupe.vectors.json'), 'utf8'),
) as { vectors: Vector[] };

describe('dedupe-key — shared vectors', () => {
  for (const v of fixture.vectors) {
    it(`reproduces key: ${v.name}`, () => {
      assert.equal(generateDedupeKey(v.input), v.key);
    });
  }

  it('canonicalization equivalences hold', () => {
    const base: DedupeParams = { target_url: 'https://api.example.com/p?a=1&b=2', method: 'GET' };
    // query order is normalized
    assert.equal(generateDedupeKey(base), generateDedupeKey({ ...base, target_url: 'https://api.example.com/p?b=2&a=1' }));
    // host case + default port are normalized
    assert.equal(generateDedupeKey(base), generateDedupeKey({ ...base, target_url: 'https://API.example.com:443/p?a=1&b=2' }));
    // method case is normalized
    assert.equal(generateDedupeKey(base), generateDedupeKey({ ...base, method: 'get' }));
  });

  it('distinct requests produce distinct keys', () => {
    assert.notEqual(
      generateDedupeKey({ target_url: 'https://api.example.com/a', method: 'GET' }),
      generateDedupeKey({ target_url: 'https://api.example.com/b', method: 'GET' }),
    );
  });
});
