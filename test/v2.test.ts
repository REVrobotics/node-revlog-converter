import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convert,
  kA301Firmware,
  kA301Status0,
  kSparkFirmware,
  kSparkStatus0,
} from './fixtures.js';
import {
  controlWord,
  readWpilog,
  record,
  v2BusTable,
  v2Diagnostics,
  v2Event,
  v2Firmware,
  v2Frames,
  v2Header,
  v2MatchInfo,
  v2RobotState,
  valuesOf,
} from './helpers.js';

const file = (...parts: number[][]) => Buffer.from(parts.flat());
const sparkStatus0 = [0x10, 0x27, 0xc8, 0x00, 0x96, 0x11, 0x2c, 0x01];
const buses = v2BusTable([
  { id: 0, name: 'CAN_S0' },
  { id: 1, name: 'CAN_S1' },
]);

test('v2 rejects a newer major version with a clear message', async () => {
  await assert.rejects(
    convert(file(v2Header({ major: 3, minor: 1 }))),
    /format version 3\.1.*Update @rev-robotics\/revlog-converter/
  );
});

test('v2 file with only events converts', async () => {
  const { values } = readWpilog(
    await convert(file(v2Header(), buses, v2Event(5, 1), v2Event(9, 3)))
  );
  assert.deepEqual(
    valuesOf(values, 'REV/StatusLogger/Event').map((v) => [
      v.timestampUs,
      v.value,
    ]),
    [
      [5n, 'started'],
      [9n, 'stopped'],
    ]
  );
});

test('v2 frames use microsecond times and bus names', async () => {
  const { values } = readWpilog(
    await convert(
      file(
        v2Header(),
        buses,
        v2Frames(0, 1_000_000, [
          { offsetUs: 0, id: kSparkStatus0 | 3, data: sparkStatus0 },
          { offsetUs: 1_234, id: kSparkStatus0 | 3, data: sparkStatus0 },
        ]),
        v2Frames(1, 1_000_500, [
          { offsetUs: 0, id: kSparkStatus0 | 3, data: sparkStatus0 },
        ])
      )
    )
  );
  const s0 = valuesOf(values, 'REV/CAN_S0/Spark-3/APPLIED_OUTPUT');
  const s1 = valuesOf(values, 'REV/CAN_S1/Spark-3/APPLIED_OUTPUT');
  assert.deepEqual(
    s0.map((v) => v.timestampUs),
    [1_000_000n, 1_001_234n]
  );
  assert.deepEqual(
    s1.map((v) => v.timestampUs),
    [1_000_500n]
  );
  assert.equal(valuesOf(values, 'REV/Spark-3/APPLIED_OUTPUT').length, 0);
});

test('v2 bus missing from the table gets a fallback name', async () => {
  const { values } = readWpilog(
    await convert(
      file(
        v2Header(),
        buses,
        v2Frames(7, 10, [
          { offsetUs: 0, id: kSparkStatus0 | 1, data: sparkStatus0 },
        ])
      )
    )
  );
  assert.ok(valuesOf(values, 'REV/CAN_7/Spark-1/APPLIED_OUTPUT').length > 0);
});

test('v2 long CAN FD frames decode like 8-byte frames', async () => {
  const fd = [...sparkStatus0, ...new Array(56).fill(0xee)];
  const decode = async (data: number[]) =>
    readWpilog(
      await convert(
        file(
          v2Header(),
          buses,
          v2Frames(0, 10, [{ offsetUs: 0, id: kSparkStatus0 | 1, data }])
        )
      )
    ).values.map((v) => [v.name, v.value]);
  assert.deepEqual(await decode(fd), await decode(sparkStatus0));
});

test('v2 A301 frames decode with the A301 DBC, not the SPARK one', async () => {
  const { values } = readWpilog(
    await convert(
      file(
        v2Header(),
        buses,
        v2Frames(0, 10, [
          { offsetUs: 0, id: kA301Status0 | 3, data: sparkStatus0 },
        ]),
        v2Firmware([
          { bus: 0, id: kA301Firmware | 3, data: [1, 2, 0, 3, 0, 1, 0, 0] },
        ])
      )
    )
  );
  assert.equal(values.filter((v) => v.name.includes('/Spark-3/')).length, 0);
  // STATUS_0: APPLIED_OUTPUT, VOLTAGE, CURRENT, MOTOR_TEMPERATURE, ...
  const temperature = valuesOf(values, 'REV/CAN_S0/A301-3/MOTOR_TEMPERATURE');
  assert.equal(temperature.length, 1);
  assert.equal(Number(temperature[0].value), 0x11); // byte 5
  assert.ok(valuesOf(values, 'REV/CAN_S0/A301-3/VOLTAGE').length === 1);
  assert.deepEqual(
    valuesOf(values, 'REV/CAN_S0/A301-3/FIRMWARE').map((v) => v.value),
    ['1.2.3']
  );
});

test('v2 firmware is written when it changes, at the latest time', async () => {
  const fw = (minor: number) =>
    v2Firmware([
      { bus: 0, id: kSparkFirmware | 2, data: [25, minor, 0, 4, 0, 0, 0, 0] },
    ]);
  const { values } = readWpilog(
    await convert(
      file(
        v2Header({ startUs: 100 }),
        buses,
        fw(0),
        v2Frames(0, 5_000, [
          { offsetUs: 0, id: kSparkStatus0 | 2, data: sparkStatus0 },
        ]),
        fw(0),
        fw(0),
        fw(1)
      )
    )
  );
  assert.deepEqual(
    valuesOf(values, 'REV/CAN_S0/Spark-2/FIRMWARE').map((v) => [
      v.timestampUs,
      v.value,
    ]),
    [
      [100n, '25.0.4'],
      [5_000n, '25.1.4'],
    ]
  );
});

test('v2 robot state becomes the DS entries AdvantageScope reads', async () => {
  const disabled = controlWord({ ds: true });
  const auto = controlWord({ ds: true, enabled: true, mode: 1 });
  const teleop = controlWord({ ds: true, enabled: true, mode: 2 });
  const { values } = readWpilog(
    await convert(
      file(
        v2Header(),
        buses,
        v2RobotState(10, disabled),
        v2RobotState(20, auto),
        v2RobotState(30, auto),
        v2RobotState(40, disabled),
        v2RobotState(50, teleop)
      )
    )
  );
  assert.deepEqual(
    valuesOf(values, 'DS:controlWord/enabled').map((v) => [
      v.timestampUs,
      v.value,
    ]),
    [
      [10n, false],
      [20n, true],
      [40n, false],
      [50n, true],
    ]
  );
  assert.deepEqual(
    valuesOf(values, 'DS:controlWord/robotMode').map((v) => [
      v.timestampUs,
      v.value,
    ]),
    [
      [10n, 'unknown'],
      [20n, 'autonomous'],
      [40n, 'unknown'],
      [50n, 'teleoperated'],
    ]
  );
  const types = [
    ...readWpilog(
      await convert(file(v2Header(), v2RobotState(1, auto)))
    ).entries.values(),
  ];
  assert.deepEqual(
    types.map((e) => [e.name, e.type]),
    [
      ['DS:controlWord/enabled', 'boolean'],
      ['DS:controlWord/robotMode', 'string'],
    ]
  );
});

test('v2 match info becomes DS:matchInfo entries', async () => {
  const { values, entries } = readWpilog(
    await convert(file(v2Header(), v2MatchInfo(7, 2, 12, 1, 'CASJ')))
  );
  assert.deepEqual(
    values.map((v) => [v.name, v.value]),
    [
      ['DS:matchInfo/eventName', 'CASJ'],
      ['DS:matchInfo/matchType', 2n],
      ['DS:matchInfo/matchNumber', 12n],
    ]
  );
  assert.ok(
    [...entries.values()].every(
      (e) => e.name !== 'DS:matchInfo/matchType' || e.type === 'int64'
    )
  );
});

test('v2 events include their detail', async () => {
  const { values } = readWpilog(
    await convert(
      file(v2Header(), v2Event(3, 5, '/home/systemcore/logs'), v2Event(4, 99))
    )
  );
  assert.deepEqual(
    valuesOf(values, 'REV/StatusLogger/Event').map((v) => v.value),
    ['usb-removed: /home/systemcore/logs', 'event-99']
  );
});

test('v2 diagnostics are running totals per bus', async () => {
  const { values } = readWpilog(
    await convert(
      file(
        v2Header(),
        buses,
        v2Diagnostics(10, [{ bus: 0, kind: 1, count: 3 }]),
        v2Diagnostics(20, [
          { bus: 0, kind: 1, count: 2 },
          { bus: 1, kind: 1, count: 4 },
        ])
      )
    )
  );
  assert.deepEqual(
    valuesOf(values, 'REV/StatusLogger/CAN_S0/DroppedFrames').map(
      (v) => v.value
    ),
    [3n, 5n]
  );
  assert.deepEqual(
    valuesOf(values, 'REV/StatusLogger/CAN_S1/DroppedFrames').map(
      (v) => v.value
    ),
    [4n]
  );
});

test('v2 unknown record IDs are skipped', async () => {
  const { values } = readWpilog(
    await convert(file(v2Header(), record(42, [1, 2, 3]), v2Event(1, 1)))
  );
  assert.equal(values.length, 1);
});
