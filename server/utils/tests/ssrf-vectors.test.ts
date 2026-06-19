import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { resolveAndCheckTarget } from '../ssrf.ts';

interface Case {
  url: string;
  expect: 'allow' | 'block';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../ssrf.vectors.json'), 'utf8')) as {
  cases: Case[];
};

describe('SSRF guard — shared vectors', () => {
  it('has both allow and block cases', () => {
    assert.ok(fixture.cases.some((c) => c.expect === 'allow'));
    assert.ok(fixture.cases.filter((c) => c.expect === 'block').length >= 10);
  });

  for (const c of fixture.cases) {
    it(`${c.expect}: ${c.url}`, async () => {
      if (c.expect === 'allow') {
        const resolved = await resolveAndCheckTarget(c.url);
        assert.ok(resolved.ip, `expected ${c.url} to be allowed`);
      } else {
        await assert.rejects(() => resolveAndCheckTarget(c.url), /Forbidden/, `expected ${c.url} to be blocked`);
      }
    });
  }
});
