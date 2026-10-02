import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { convert, v1Fixture } from './fixtures.js';
import { readWpilog } from './helpers.js';

interface Saved {
  name: string;
  type: string;
  timestampUs: string;
  value: string | number | boolean;
}

const baseline: Saved[] = JSON.parse(
  readFileSync(new URL('./fixtures/v1-baseline.json', import.meta.url), 'utf-8')
);

const normalize = (v: {
  name: string;
  type: string;
  timestampUs: bigint | string;
  value: unknown;
}) => ({
  name: v.name,
  type: v.type,
  timestampUs: v.timestampUs.toString(),
  value: typeof v.value === 'bigint' ? v.value.toString() : v.value,
});

const isFirmware = (name: string) => name.endsWith('/FIRMWARE');

test('v1 signal output matches converter 1.0.5', async () => {
  const { values } = readWpilog(await convert(v1Fixture()));
  const actual = values.filter((v) => !isFirmware(v.name)).map(normalize);
  const expected = baseline.filter((v) => !isFirmware(v.name));
  assert.deepEqual(actual, expected);
});
