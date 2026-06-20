// Generates dedupe-key test vectors. Deterministic (generateDedupeKey is pure),
// so re-running is byte-identical. Mirrored verbatim into consensus-node so its
// copy of dedupe.ts is proven to produce identical keys.
//   npm run gen:dedupe-vectors

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDedupeKey, type DedupeParams } from './dedupe.ts';

const cases: Array<{ name: string; input: DedupeParams }> = [
  { name: 'simple-get', input: { target_url: 'https://api.example.com/v1/price', method: 'GET' } },
  { name: 'query-sorted', input: { target_url: 'https://api.example.com/p?b=2&a=1', method: 'GET' } },
  { name: 'default-port-stripped', input: { target_url: 'https://api.example.com:443/p', method: 'GET' } },
  { name: 'host-lowercased', input: { target_url: 'https://API.Example.COM/p', method: 'get' } },
  { name: 'api-key-scope', input: { target_url: 'https://api.example.com/p', method: 'GET', headers: { 'x-api-key': 'secret' } } },
  {
    name: 'semantic-headers-only',
    input: {
      target_url: 'https://api.example.com/p',
      method: 'GET',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-other': 'ignored' },
    },
  },
  { name: 'json-body-sorted', input: { target_url: 'https://api.example.com/p', method: 'POST', body: { b: 2, a: 1 } } },
  { name: 'string-body', input: { target_url: 'https://api.example.com/p', method: 'POST', body: 'raw-body' } },
];

const vectors = cases.map((c) => ({ name: c.name, input: c.input, key: generateDedupeKey(c.input) }));
const fixture = {
  _comment:
    'TEST vectors locking the dedupe-key canonicalization. Mirrored verbatim into consensus-node. Regenerate: npm run gen:dedupe-vectors',
  vectors,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'test-vectors');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'dedupe.vectors.json');
fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${vectors.length} dedupe vectors → ${path.relative(process.cwd(), outPath)}`);
