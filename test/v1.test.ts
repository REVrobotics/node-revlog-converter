import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { convert, v1Fixture } from './fixtures.js';
import { readWpilog, v1Periodic } from './helpers.js';

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

test('v1 firmware is written once per device with correct versions', async () => {
  const { values } = readWpilog(await convert(v1Fixture()));
  const firmware = values.filter((v) => isFirmware(v.name));
  assert.deepEqual(
    firmware.map((v) => [v.name, v.value]),
    [
      ['REV/Spark-3/FIRMWARE', '25.0.4'],
      // fix 2, minor 1, year 25 (converter 1.0.5 showed "2.1.6400")
      ['REV/ServoHub-1/FIRMWARE', '25.1.2'],
      ['REV/Encoder-9/FIRMWARE', '26.1.3'],
    ]
  );
});

test('v1 file cut mid-record converts every complete record', async () => {
  const full = v1Fixture();
  const cut = full.subarray(0, full.length - 5);
  const { values } = readWpilog(await convert(cut));
  const fullValues = readWpilog(await convert(full)).values;
  assert.ok(values.length > 0);
  assert.ok(values.length < fullValues.length);
});

test('v1 frames from unknown manufacturers are not decoded as SPARK', async () => {
  const bytes = Buffer.from(
    v1Periodic([
      // Manufacturer 4 (not REV), device type 2 like a SPARK
      { ms: 1, id: 0x204b800 | 3, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    ])
  );
  const { values } = readWpilog(await convert(bytes));
  assert.equal(values.length, 0);
});
