// Summarizes a REVLOG file and flags known problems, for `revlog-converter
// --stats`. Works on the whole file in memory.

export interface RecordStats {
  count: number;
  bytes: number;
}

export interface DeviceStats {
  bus: number;
  manufacturer: number;
  deviceType: number;
  deviceNumber: number;
  frames: number;
  framesByIndex: Map<number, number>;
}

export interface RevlogStats {
  formatVersion: string;
  fileBytes: number;
  truncatedBytes: number;
  records: Map<number, RecordStats>;
  firstTimestampUs: bigint | null;
  lastTimestampUs: bigint | null;
  durationSeconds: number | null;
  devices: DeviceStats[];
  firmwareRecords: number;
  timestampWraps: number;
  events: string[];
  droppedFrames: number;
  warnings: string[];
}

const RECORD_NAMES: Record<number, string> = {
  1: 'persistent (v1 firmware table)',
  2: 'periodic (v1 status frames)',
  3: 'header',
  4: 'bus table',
  5: 'firmware table',
  6: 'frames',
  7: 'robot state',
  8: 'match info',
  9: 'logger event',
  10: 'diagnostics',
};

const EVENT_NAMES: Record<number, string> = {
  1: 'started',
  2: 'capturing',
  3: 'stopped',
  4: 'resumed',
  5: 'usb-removed',
  6: 'directory-changed',
};

const DEVICE_NAMES: Record<number, string> = {
  [(5 << 8) | 2]: 'SPARK',
  [(5 << 8) | 7]: 'Encoder',
  [(5 << 8) | 12]: 'Servo Hub',
  [(3 << 8) | 2]: 'A301',
};

export function analyzeREVLOG(buf: Buffer): RevlogStats {
  const stats: RevlogStats = {
    formatVersion: 'unknown',
    fileBytes: buf.length,
    truncatedBytes: 0,
    records: new Map(),
    firstTimestampUs: null,
    lastTimestampUs: null,
    durationSeconds: null,
    devices: [],
    firmwareRecords: 0,
    timestampWraps: 0,
    events: [],
    droppedFrames: 0,
    warnings: [],
  };
  const devices = new Map<string, DeviceStats>();
  let lastV1Ms: number | null = null;
  let v1WrapOffsetUs = 0n;
  let isV2: boolean | null = null;
  // Distinct (bus, message ID) firmware replies seen in v2 firmware tables
  const firmwareEntries = new Set<string>();

  const noteTime = (us: bigint) => {
    if (stats.firstTimestampUs === null || us < stats.firstTimestampUs) {
      stats.firstTimestampUs = us;
    }
    if (stats.lastTimestampUs === null || us > stats.lastTimestampUs) {
      stats.lastTimestampUs = us;
    }
  };

  const noteFrame = (bus: number, messageId: number) => {
    const key = `${bus}:${messageId & 0x1fff003f}`;
    let device = devices.get(key);
    if (!device) {
      device = {
        bus,
        manufacturer: (messageId >> 16) & 0xff,
        deviceType: (messageId >> 24) & 0x1f,
        deviceNumber: messageId & 0x3f,
        frames: 0,
        framesByIndex: new Map(),
      };
      devices.set(key, device);
    }
    device.frames++;
    const index = (messageId >> 6) & 0xf;
    device.framesByIndex.set(index, (device.framesByIndex.get(index) ?? 0) + 1);
  };

  let pos = 0;
  while (pos < buf.length) {
    const bitfield = buf[pos];
    const idLen = (bitfield & 3) + 1;
    const sizeLen = ((bitfield >> 2) & 3) + 1;
    if (pos + 1 + idLen + sizeLen > buf.length) break;
    const id = buf.readUIntLE(pos + 1, idLen);
    const size = buf.readUIntLE(pos + 1 + idLen, sizeLen);
    const start = pos + 1 + idLen + sizeLen;
    if (start + size > buf.length) break;
    const payload = buf.subarray(start, start + size);
    pos = start + size;

    if (isV2 === null) {
      isV2 = id === 3;
      stats.formatVersion = isV2 ? '2' : '1';
    }
    const r = stats.records.get(id) ?? { count: 0, bytes: 0 };
    r.count++;
    r.bytes += 1 + idLen + sizeLen + size;
    stats.records.set(id, r);

    if (!isV2) {
      if (id === 1) stats.firmwareRecords++;
      if (id === 2) {
        for (let p = 0; p + 16 <= payload.length; p += 16) {
          const ms = payload.readUInt32LE(p);
          // Big backwards jumps mean the 32-bit value wrapped
          if (lastV1Ms !== null && ms < lastV1Ms && lastV1Ms - ms > 2 ** 31) {
            stats.timestampWraps++;
            v1WrapOffsetUs += 2n ** 32n * 1000n;
          }
          lastV1Ms = ms;
          noteTime(BigInt(ms) * 1000n + v1WrapOffsetUs);
          noteFrame(0, payload.readUInt32LE(p + 4));
        }
      }
      continue;
    }

    switch (id) {
      case 3:
        if (payload.length >= 8) {
          stats.formatVersion = `${payload[6]}.${payload[7]}`;
        }
        break;
      case 5: {
        stats.firmwareRecords++;
        let p = 0;
        while (p + 6 <= payload.length) {
          firmwareEntries.add(`${payload[p]}:${payload.readUInt32LE(p + 1)}`);
          p += 6 + payload[p + 5];
        }
        break;
      }
      case 6: {
        if (payload.length < 9) break;
        const base = payload.readBigUInt64LE(0);
        const bus = payload[8];
        let p = 9;
        while (p + 7 <= payload.length) {
          const n = payload[p + 6];
          noteTime(base + BigInt(payload.readUInt16LE(p)));
          noteFrame(bus, payload.readUInt32LE(p + 2));
          p += 7 + n;
        }
        break;
      }
      case 9:
        if (payload.length >= 10) {
          const t = payload.readBigUInt64LE(0);
          const n = payload[9];
          const detail = payload.subarray(10, 10 + n).toString('utf-8');
          const name = EVENT_NAMES[payload[8]] ?? `event-${payload[8]}`;
          stats.events.push(
            `${(Number(t) / 1e6).toFixed(3)} s ${name}${detail ? ': ' + detail : ''}`
          );
        }
        break;
      case 10:
        for (let p = 8; p + 6 <= payload.length; p += 6) {
          if (payload[p + 1] === 1)
            stats.droppedFrames += payload.readUInt32LE(p + 2);
        }
        break;
    }
  }
  stats.truncatedBytes = buf.length - pos;

  if (stats.firstTimestampUs !== null && stats.lastTimestampUs !== null) {
    stats.durationSeconds =
      Number(stats.lastTimestampUs - stats.firstTimestampUs) / 1e6;
  }
  stats.devices = [...devices.values()].sort(
    (a, b) =>
      a.bus - b.bus ||
      a.manufacturer - b.manufacturer ||
      a.deviceType - b.deviceType ||
      a.deviceNumber - b.deviceNumber
  );

  // --- Known problems ---
  const duration = stats.durationSeconds;
  // The span between first and last frame misses one logger loop (25 ms),
  // which matters for short files
  const firmwareRate =
    duration !== null ? stats.firmwareRecords / (duration + 0.025) : null;
  if (stats.timestampWraps > 0) {
    stats.warnings.push(
      `Timestamps wrapped ${stats.timestampWraps} times. REVLib ` +
        `2027.0.0-alpha-1 to alpha-8 stored truncated nanoseconds, so times ` +
        `in this file are wrong. If the values are nanoseconds, the log ` +
        `covers about ${((stats.timestampWraps + 1) * 4.295).toFixed(0)} s or less.`
    );
  }
  if (stats.formatVersion !== '1') {
    // v2 writes the table at file start and when a device's firmware first
    // arrives or changes, so a healthy file has about one per device
    const expected = 2 * firmwareEntries.size + 2;
    if (stats.firmwareRecords > expected) {
      stats.warnings.push(
        `The firmware table was written ${stats.firmwareRecords} times for ` +
          `${firmwareEntries.size} devices; it should only be written at ` +
          `file start and when a firmware version changes.`
      );
    }
  }
  if (firmwareRate !== null && stats.timestampWraps === 0) {
    if (stats.formatVersion === '1' && firmwareRate > 130) {
      stats.warnings.push(
        `The firmware table was written ${firmwareRate.toFixed(0)} times a ` +
          `second. The logger loop ran faster than 40 Hz (REVLib ` +
          `2027.0.0-alpha-7 and earlier 2027 alphas).`
      );
    }
  }
  if (stats.formatVersion === '1' && stats.timestampWraps > 0) {
    // Without usable times, compare against the frame count instead
    const statusFrames = stats.devices.reduce((n, d) => n + d.frames, 0);
    if (stats.firmwareRecords > statusFrames * 3) {
      stats.warnings.push(
        `There are ${stats.firmwareRecords} firmware tables for ` +
          `${statusFrames} status frames. The logger loop ran far faster ` +
          `than 40 Hz (REVLib 2027.0.0-alpha-7 and earlier 2027 alphas).`
      );
    }
  }
  const firmwareBytes =
    (stats.records.get(1)?.bytes ?? 0) + (stats.records.get(5)?.bytes ?? 0);
  if (buf.length > 0 && firmwareBytes / buf.length > 0.5) {
    stats.warnings.push(
      `${((100 * firmwareBytes) / buf.length).toFixed(0)}% of the file is ` +
        `repeated firmware tables.`
    );
  }
  if (stats.droppedFrames > 0) {
    stats.warnings.push(
      `${stats.droppedFrames} CAN stream overflows were recorded; some frames are missing.`
    );
  }
  if (stats.truncatedBytes > 0) {
    stats.warnings.push(
      `The file ends with ${stats.truncatedBytes} bytes of an incomplete ` +
        `record (for example, power was lost).`
    );
  }
  return stats;
}

export function formatStats(stats: RevlogStats): string {
  const lines: string[] = [];
  const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
  lines.push(`Format version: ${stats.formatVersion}`);
  lines.push(`File size: ${mb(stats.fileBytes)}`);
  if (stats.durationSeconds !== null) {
    lines.push(`Time span: ${stats.durationSeconds.toFixed(3)} s`);
  }
  lines.push('', 'Records:');
  for (const [id, r] of [...stats.records.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    const share = stats.fileBytes ? (100 * r.bytes) / stats.fileBytes : 0;
    lines.push(
      `  ${String(id).padStart(3)} ${(RECORD_NAMES[id] ?? 'unknown').padEnd(32)} ` +
        `${String(r.count).padStart(10)} records ${mb(r.bytes).padStart(11)} ` +
        `(${share.toFixed(1)}%)`
    );
  }
  lines.push('', 'Devices:');
  for (const d of stats.devices) {
    const name =
      DEVICE_NAMES[(d.manufacturer << 8) | d.deviceType] ??
      `type ${d.deviceType}, manufacturer ${d.manufacturer}`;
    const rate =
      // Rates are meaningless for very short logs
      stats.durationSeconds && stats.durationSeconds >= 1
        ? ` (${(d.frames / stats.durationSeconds).toFixed(1)}/s)`
        : '';
    const byIndex = [...d.framesByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, n]) => `${i}:${n}`)
      .join(' ');
    lines.push(
      `  bus ${d.bus} ${name} ${d.deviceNumber}: ${d.frames} frames${rate}, by status frame ${byIndex}`
    );
  }
  if (stats.events.length > 0) {
    lines.push('', 'Logger events:');
    for (const e of stats.events) lines.push(`  ${e}`);
  }
  lines.push('', stats.warnings.length ? 'Problems:' : 'No problems found.');
  for (const w of stats.warnings) lines.push(`  - ${w}`);
  return lines.join('\n') + '\n';
}
