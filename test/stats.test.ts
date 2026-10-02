import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeREVLOG, formatStats } from '../src/lib/revlogStats.js';
import { kSparkFirmware, kSparkStatus0, v1Fixture } from './fixtures.js';
import {
  v1Periodic,
  v1Persistent,
  v2BusTable,
  v2Diagnostics,
  v2Event,
  v2Firmware,
  v2Frames,
  v2Header,
} from './helpers.js';

const sparkStatus0 = [0x10, 0x27, 0xc8, 0x00, 0x96, 0x11, 0x2c, 0x01];

test('a healthy v2 log has no problems', () => {
  const parts: number[][] = [
    v2Header(),
    v2BusTable([{ id: 0, name: 'CAN_S0' }]),
    v2Event(1_000_000, 1),
  ];
  // The table is written once, when the device's firmware arrives
  parts.push(
    v2Firmware([
      { bus: 0, id: kSparkFirmware | 1, data: [25, 0, 0, 4, 0, 0, 0, 0] },
    ])
  );
  for (let s = 0; s < 10; s++) {
    for (let loop = 0; loop < 40; loop++) {
      parts.push(
        v2Frames(0, 1_000_000 + s * 1_000_000 + loop * 25_000, [
          { offsetUs: 0, id: kSparkStatus0 | 1, data: sparkStatus0 },
          { offsetUs: 10_000, id: kSparkStatus0 | 1, data: sparkStatus0 },
        ])
      );
    }
  }
  const stats = analyzeREVLOG(Buffer.from(parts.flat()));
  assert.equal(stats.formatVersion, '2.0');
  assert.deepEqual(stats.warnings, []);
  assert.equal(stats.devices.length, 1);
  assert.equal(stats.devices[0].frames, 800);
  assert.ok(Math.abs((stats.durationSeconds ?? 0) - 9.985) < 0.001);
  assert.match(formatStats(stats), /No problems found/);
  assert.match(formatStats(stats), /started/);
});

test('a SystemcoreTesting#398-style log is flagged', () => {
  // REVLib 2027.0.0-alpha-7: truncated-nanosecond timestamps that wrap, and
  // three firmware tables per loop at thousands of loops per second
  const table = v1Persistent([
    { id: kSparkFirmware | 1, data: [25, 0, 0, 4, 0, 0x45] },
  ]);
  const parts: number[][] = [];
  let ns = 4_294_000_000; // near the 32-bit wrap
  for (let i = 0; i < 400; i++) {
    for (let j = 0; j < 30; j++) parts.push(table);
    ns = (ns + 20_000_000) % 2 ** 32;
    parts.push(
      v1Periodic([{ ms: ns, id: kSparkStatus0 | 1, data: sparkStatus0 }])
    );
  }
  const stats = analyzeREVLOG(Buffer.from(parts.flat()));
  const text = stats.warnings.join('\n');
  assert.ok(stats.timestampWraps >= 1);
  assert.match(text, /wrapped/);
  assert.match(text, /far faster than 40 Hz/);
  assert.match(text, /repeated firmware tables/);
});

test('a normal pre-revamp v1 log only notes repeated firmware', () => {
  const stats = analyzeREVLOG(v1Fixture());
  assert.equal(stats.formatVersion, '1');
  assert.equal(stats.timestampWraps, 0);
  assert.ok(!stats.warnings.some((w) => /faster than 40 Hz|wrapped/.test(w)));
});

test('overflows and truncated files are reported', () => {
  const full = Buffer.from(
    [
      v2Header(),
      v2Diagnostics(5, [{ bus: 0, kind: 1, count: 7 }]),
      v2Event(6, 1),
    ].flat()
  );
  const stats = analyzeREVLOG(full.subarray(0, full.length - 3));
  assert.equal(stats.droppedFrames, 7);
  assert.ok(stats.truncatedBytes > 0);
  assert.equal(stats.warnings.length, 2);
});

test('a v2 log that repeats the firmware table is flagged', () => {
  const table = v2Firmware([
    { bus: 0, id: kSparkFirmware | 1, data: [25, 0, 0, 4, 0, 0, 0, 0] },
  ]);
  const parts: number[][] = [v2Header(), table];
  for (let i = 0; i < 10; i++) {
    parts.push(
      v2Frames(0, 1_000_000 + i * 1_000_000, [
        { offsetUs: 0, id: kSparkStatus0 | 1, data: sparkStatus0 },
      ]),
      table
    );
  }
  const stats = analyzeREVLOG(Buffer.from(parts.flat()));
  assert.match(
    stats.warnings.join('\n'),
    /written 11 times for 1 devices; it should only be written at file start/
  );
});
