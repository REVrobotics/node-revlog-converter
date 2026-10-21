// Test helpers: build REVLOG files byte by byte (per the REVLib format specs)
// and read WPILOG files back.

export const kRecordPersistent = 1;
export const kRecordPeriodic = 2;
export const kRecordHeader = 3;
export const kRecordBusTable = 4;
export const kRecordFirmware = 5;
export const kRecordFrames = 6;
export const kRecordRobotState = 7;
export const kRecordMatchInfo = 8;
export const kRecordLoggerEvent = 9;
export const kRecordDiagnostics = 10;

const le = (value: number | bigint, bytes: number): number[] => {
  let v = BigInt(value);
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
};

const shortString = (text: string): number[] => {
  const bytes = [...Buffer.from(text, 'utf-8')];
  return [bytes.length, ...bytes];
};

export const record = (id: number, payload: number[]): number[] => {
  const size = payload.length;
  const sizeBytes =
    size <= 0xff ? 1 : size <= 0xffff ? 2 : size <= 0xffffff ? 3 : 4;
  return [((sizeBytes - 1) & 3) << 2, id, ...le(size, sizeBytes), ...payload];
};

// --- Format v1 ---

export const v1Persistent = (
  entries: { id: number; data: number[] }[]
): number[] =>
  record(
    kRecordPersistent,
    entries.flatMap((e) => [...le(e.id, 4), ...e.data.slice(0, 6)])
  );

export const v1Periodic = (
  entries: { ms: number; id: number; data: number[] }[]
): number[] =>
  record(
    kRecordPeriodic,
    entries.flatMap((e) => {
      const data = [...e.data, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);
      return [...le(e.ms, 4), ...le(e.id, 4), ...data];
    })
  );

// --- Format v2 ---

export const v2Header = (
  opts: { major?: number; minor?: number; startUs?: number } = {}
): number[] =>
  record(kRecordHeader, [
    ...Buffer.from('REVLOG'),
    opts.major ?? 2,
    opts.minor ?? 0,
    ...le(opts.startUs ?? 0, 8),
    ...le(0, 8),
    ...shortString('REVLib test'),
  ]);

export const v2BusTable = (buses: { id: number; name: string }[]): number[] =>
  record(
    kRecordBusTable,
    buses.flatMap((b) => [b.id, ...shortString(b.name)])
  );

export const v2Firmware = (
  entries: { bus: number; id: number; data: number[] }[]
): number[] =>
  record(
    kRecordFirmware,
    entries.flatMap((e) => [e.bus, ...le(e.id, 4), e.data.length, ...e.data])
  );

export const v2Frames = (
  bus: number,
  baseUs: number,
  entries: { offsetUs: number; id: number; data: number[] }[]
): number[] =>
  record(kRecordFrames, [
    ...le(baseUs, 8),
    bus,
    ...entries.flatMap((e) => [
      ...le(e.offsetUs, 2),
      ...le(e.id, 4),
      e.data.length,
      ...e.data,
    ]),
  ]);

export const v2RobotState = (timeUs: number, controlWord: bigint): number[] =>
  record(kRecordRobotState, [...le(timeUs, 8), ...le(controlWord, 8)]);

export const v2MatchInfo = (
  timeUs: number,
  type: number,
  number: number,
  replay: number,
  event: string
): number[] =>
  record(kRecordMatchInfo, [
    ...le(timeUs, 8),
    type,
    ...le(number, 2),
    replay,
    ...shortString(event),
  ]);

export const v2Event = (timeUs: number, code: number, detail = ''): number[] =>
  record(kRecordLoggerEvent, [...le(timeUs, 8), code, ...shortString(detail)]);

export const v2Diagnostics = (
  timeUs: number,
  entries: { bus: number; kind: number; count: number }[]
): number[] =>
  record(kRecordDiagnostics, [
    ...le(timeUs, 8),
    ...entries.flatMap((e) => [e.bus, e.kind, ...le(e.count, 4)]),
  ]);

export const controlWord = (opts: {
  enabled?: boolean;
  mode?: number;
  fms?: boolean;
  ds?: boolean;
}): bigint =>
  (BigInt(opts.mode ?? 0) << 56n) |
  (opts.enabled ? 1n << 58n : 0n) |
  (opts.fms ? 1n << 60n : 0n) |
  (opts.ds ? 1n << 61n : 0n);

// --- WPILOG reader ---

export interface WpilogEntry {
  name: string;
  type: string;
  metadata: string;
}

export interface WpilogValue {
  name: string;
  type: string;
  timestampUs: bigint;
  value: string | number | boolean | bigint;
}

export const readWpilog = (
  buf: Buffer
): { entries: Map<number, WpilogEntry>; values: WpilogValue[] } => {
  if (buf.subarray(0, 6).toString('ascii') !== 'WPILOG') {
    throw new Error('not a WPILOG');
  }
  const extraLen = buf.readUInt32LE(8);
  let pos = 12 + extraLen;
  const entries = new Map<number, WpilogEntry>();
  const values: WpilogValue[] = [];
  while (pos < buf.length) {
    const bitfield = buf[pos];
    const idLen = (bitfield & 3) + 1;
    const sizeLen = ((bitfield >> 2) & 3) + 1;
    const tsLen = ((bitfield >> 4) & 7) + 1;
    let p = pos + 1;
    const id = buf.readUIntLE(p, idLen);
    p += idLen;
    const size = buf.readUIntLE(p, sizeLen);
    p += sizeLen;
    let ts = 0n;
    for (let i = 0; i < tsLen; i++) ts |= BigInt(buf[p + i]) << BigInt(8 * i);
    p += tsLen;
    const payload = buf.subarray(p, p + size);
    pos = p + size;
    if (id === 0) {
      if (payload[0] !== 0) continue;
      let q = 1;
      const entryId = payload.readUInt32LE(q);
      q += 4;
      const read = () => {
        const n = payload.readUInt32LE(q);
        q += 4;
        const s = payload.subarray(q, q + n).toString('utf-8');
        q += n;
        return s;
      };
      const name = read();
      const type = read();
      const metadata = read();
      entries.set(entryId, { name, type, metadata });
      continue;
    }
    const entry = entries.get(id);
    if (!entry) throw new Error(`record for unknown entry ${id}`);
    let value: string | number | boolean | bigint;
    switch (entry.type) {
      case 'boolean':
        value = payload[0] !== 0;
        break;
      case 'int64':
        value = payload.readBigInt64LE(0);
        break;
      case 'float':
        value = payload.readFloatLE(0);
        break;
      case 'double':
        value = payload.readDoubleLE(0);
        break;
      default:
        value = payload.toString('utf-8');
    }
    values.push({ name: entry.name, type: entry.type, timestampUs: ts, value });
  }
  return { entries, values };
};

export const valuesOf = (values: WpilogValue[], name: string) =>
  values.filter((v) => v.name === name);
