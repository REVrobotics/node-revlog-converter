import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { Readable, Writable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';
import { Dbc, CanDecoder, Message, Signal } from './revDBC.js';

// REVLOG format versions this converter reads. See docs/revlog-format-v1.md
// and docs/revlog-format-v2.md in REVLib.
export const SUPPORTED_REVLOG_MAJOR_VERSION = 2;

export async function parseREVLOG(
  input: string | Buffer | Readable,
  outputTarget?: string | Writable
): Promise<void> {
  // --- Stream Setup ---
  let readStream: Readable;
  let writeStream: Writable | null = null;

  // Handle Input
  if (input instanceof Readable) {
    readStream = input; // Captures process.stdin
  } else if (Buffer.isBuffer(input)) {
    readStream = Readable.from(input);
  } else if (typeof input === 'string') {
    readStream = createReadStream(input, { highWaterMark: 64 * 1024 });
  } else {
    throw new Error(
      'Invalid input type. Must be a path, Buffer, or Readable stream.'
    );
  }

  // Handle Output
  if (outputTarget instanceof Writable) {
    writeStream = outputTarget; // Captures process.stdout
  } else if (typeof outputTarget === 'string') {
    writeStream = createWriteStream(outputTarget);
  }

  const outputChunks: Buffer[] = [];
  let stagingBuffer: Buffer[] = [];
  let stagingSize = 0;

  const writeOut = (data: Buffer) => {
    if (writeStream) {
      stagingBuffer.push(data);
      stagingSize += data.length;
    } else {
      // Fallback if no output stream is provided
      outputChunks.push(data);
    }
  };

  // New helper to cleanly flush data to the OS and handle backpressure
  const flushStaging = async () => {
    if (writeStream && stagingBuffer.length > 0) {
      const buf = Buffer.concat(stagingBuffer);
      stagingBuffer = [];
      stagingSize = 0;

      // Write the massive chunk all at once
      if (!writeStream.write(buf)) {
        // If the OS buffer is full, wait for it to drain before continuing
        await new Promise((resolve) => writeStream!.once('drain', resolve));
      }
    }
  };

  // --- Constants ---
  const HEADER = 'WPILOG';
  const VERSION_MAJOR = 1;
  const VERSION_MINOR = 0;
  const EXTRA_HEADER = '';

  const MANUFACTURER_REV = 5;
  const MANUFACTURER_A301 = 3;
  const MOTOR_CONTROLLER_ID = 2;
  const SERVO_CONTROLLER_ID = 12;
  const ENCODER_ID = 7;

  // REVLOG record IDs
  const RECORD_PERSISTENT = 1; // v1
  const RECORD_PERIODIC = 2; // v1
  const RECORD_HEADER = 3;
  const RECORD_BUS_TABLE = 4;
  const RECORD_FIRMWARE = 5;
  const RECORD_FRAMES = 6;
  const RECORD_ROBOT_STATE = 7;
  const RECORD_MATCH_INFO = 8;
  const RECORD_LOGGER_EVENT = 9;
  const RECORD_DIAGNOSTICS = 10;

  const LOGGER_EVENTS: Record<number, string> = {
    1: 'started',
    2: 'capturing',
    3: 'stopped',
    4: 'resumed',
    5: 'usb-removed',
    6: 'directory-changed',
  };
  const ROBOT_MODES = ['unknown', 'autonomous', 'teleoperated', 'utility'];

  const RECORDS = new Map<string, { id: number; type: string }>();
  const FAST_RECORDS = new Map<number, { id: number; type: string }>();
  let NEXT_RECORD_ID = 1;
  let recordsProcessed = false;

  // --- Helpers ---
  const readVariableInt = (
    data: Buffer,
    cursor: number,
    length: number
  ): [number, number] => {
    if (cursor + length > data.length) throw new Error('Not enough data.');
    const value = data.readUIntLE(cursor, length);
    return [value, cursor + length];
  };

  const writeVariableInt = (value: number | bigint, length: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(typeof value === 'bigint' ? value : BigInt(value));
    return buf.subarray(0, length);
  };

  const requiredBytes = (value: number): 1 | 2 | 3 | 4 => {
    if (value <= 0xff) return 1;
    if (value <= 0xffff) return 2;
    if (value <= 0xffffff) return 3;
    return 4;
  };

  const requiredTimestampBytes = (value: bigint): number => {
    if (value <= 0xffn) return 1;
    if (value <= 0xffffn) return 2;
    if (value <= 0xffffffn) return 3;
    if (value <= 0xffffffffn) return 4;
    if (value <= 0xffffffffffn) return 5;
    if (value <= 0xffffffffffffn) return 6;
    if (value <= 0xffffffffffffffn) return 7;
    return 8;
  };

  const writeControlRecord = (
    entryId: number,
    entryName: string,
    dataType: string,
    metadata: string
  ) => {
    const payload = Buffer.concat([
      Buffer.from([0]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(entryId);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(Buffer.byteLength(entryName));
        return b;
      })(),
      Buffer.from(entryName, 'utf-8'),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(Buffer.byteLength(dataType));
        return b;
      })(),
      Buffer.from(dataType, 'utf-8'),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(Buffer.byteLength(metadata || ''));
        return b;
      })(),
      Buffer.from(metadata || '', 'utf-8'),
    ]);

    const bitfield =
      (requiredBytes(0) - 1) |
      ((requiredBytes(payload.length) - 1) << 2) |
      ((requiredTimestampBytes(0n) - 1) << 4);

    writeOut(Buffer.from([bitfield]));
    writeOut(writeVariableInt(0, requiredBytes(0)));
    writeOut(writeVariableInt(payload.length, requiredBytes(payload.length)));
    writeOut(writeVariableInt(0n, requiredTimestampBytes(0n)));
    writeOut(payload);

    RECORDS.set(entryName, { id: entryId, type: dataType });
  };

  const writeRecordFast = (
    recordInfo: { id: number; type: string },
    entryValue: string | number | boolean | bigint,
    timestampUs: bigint
  ) => {
    let payload: Buffer;
    switch (recordInfo.type) {
      case 'boolean':
        payload = Buffer.alloc(1);
        payload.writeUInt8(entryValue ? 1 : 0, 0);
        break;
      case 'int64':
        payload = Buffer.alloc(8);
        try {
          payload.writeBigInt64LE(
            BigInt(
              typeof entryValue === 'number'
                ? Math.round(entryValue)
                : entryValue
            ),
            0
          );
        } catch {
          payload.writeBigInt64LE(0n, 0);
        }
        break;
      case 'float':
        payload = Buffer.alloc(4);
        payload.writeFloatLE(Number(entryValue), 0);
        break;
      case 'double':
        payload = Buffer.alloc(8);
        payload.writeDoubleLE(Number(entryValue), 0);
        break;
      case 'string':
        payload = Buffer.from(String(entryValue), 'utf-8');
        break;
      default:
        return;
    }

    const payloadSize = payload.length;
    const bitfield =
      (requiredBytes(recordInfo.id) - 1) |
      ((requiredBytes(payloadSize) - 1) << 2) |
      ((requiredTimestampBytes(timestampUs) - 1) << 4);

    writeOut(Buffer.from([bitfield]));
    writeOut(writeVariableInt(recordInfo.id, requiredBytes(recordInfo.id)));
    writeOut(writeVariableInt(payloadSize, requiredBytes(payloadSize)));
    writeOut(
      writeVariableInt(timestampUs, requiredTimestampBytes(timestampUs))
    );
    writeOut(payload);
  };

  // Writes a value, creating the entry the first time it is used
  const writeRecord = (
    entryName: string,
    dataType: string,
    entryValue: string | number | boolean | bigint,
    timestampUs: bigint,
    metadata = ''
  ) => {
    if (!RECORDS.has(entryName)) {
      writeControlRecord(NEXT_RECORD_ID++, entryName, dataType, metadata);
    }
    writeRecordFast(RECORDS.get(entryName)!, entryValue, timestampUs);
  };

  // Writes a value only when it differs from the last value written
  const lastValues = new Map<string, string | number | boolean | bigint>();
  const writeIfChanged = (
    entryName: string,
    dataType: string,
    entryValue: string | number | boolean | bigint,
    timestampUs: bigint
  ) => {
    if (lastValues.get(entryName) === entryValue) return;
    lastValues.set(entryName, entryValue);
    writeRecord(entryName, dataType, entryValue, timestampUs);
  };

  const getWpilogTypeFromSignal = (signal: Signal): string => {
    if (signal.length === 1) return 'boolean';
    const isFloat =
      signal.dataType === 'float' ||
      signal.dataType === 'double' ||
      (signal.factor !== 1 && signal.factor !== 0);
    if (isFloat) {
      if (signal.length === 32 && signal.dataType === 'float') return 'float';
      return 'double';
    }
    return 'int64';
  };

  // --- Parsing Setup ---
  const readDbcFile = async (fileName: string): Promise<Dbc> => {
    let dbcPath: string;
    try {
      dbcPath = path.join(__dirname, 'resources', fileName);
    } catch (err) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename).replace(/(\/|\\)lib$/, '');
      dbcPath = path.join(__dirname, 'resources', fileName);
    }
    const content = await fs.readFile(dbcPath, { encoding: 'ascii' });
    return new Dbc().load(content);
  };

  interface Device {
    // Entry name segment in v2 files, for example "Spark"
    name: string;
    // Entry name prefix in v1 files, for example "REV/Spark-"
    v1Prefix: string;
    // Decodes status frames; absent when no DBC is available
    canDecoder?: CanDecoder;
    periodicFrames: Map<number, Message>;
    parseFirmwareVersion(data: Buffer): string;
  }

  const sparkDbc = await readDbcFile('spark.public.dbc');
  const servohubDbc = await readDbcFile('servo_hub.public.dbc');
  const encoderDbc = await readDbcFile('encoder.public.dbc');
  const a301Dbc = await readDbcFile('a301.public.dbc');

  const decoderFor = (dbc: Dbc) => {
    const c = new CanDecoder();
    c.database = dbc;
    return c;
  };

  const periodicFramesOf = (dbc: Dbc, periodicPrefix: string) =>
    new Map(
      [...dbc.messages.values()]
        .filter((m) => m.name.startsWith(periodicPrefix))
        .map((m) => {
          const apiIndex = (m.id >> 6) & 0xf;
          return [apiIndex, m];
        })
    );

  // major (u8), minor (u8), build (u16, big-endian)
  const majorMinorBuild = (data: Buffer) => {
    if (data.length < 4) return '0.0.0';
    return `${data.readUInt8(0)}.${data.readUInt8(1)}.${data.readUInt16BE(2)}`;
  };

  // Devices by manufacturer and device type; the A301 shares the SPARK's
  // device type, so the manufacturer is needed to tell them apart
  const deviceKey = (manufacturer: number, deviceType: number) =>
    (manufacturer << 8) | deviceType;

  const devices = new Map<number, Device>();
  devices.set(deviceKey(MANUFACTURER_REV, MOTOR_CONTROLLER_ID), {
    name: 'Spark',
    v1Prefix: 'REV/Spark-',
    canDecoder: decoderFor(sparkDbc),
    periodicFrames: periodicFramesOf(sparkDbc, 'STATUS_'),
    parseFirmwareVersion: majorMinorBuild,
  });
  devices.set(deviceKey(MANUFACTURER_REV, SERVO_CONTROLLER_ID), {
    name: 'ServoHub',
    v1Prefix: 'REV/ServoHub-',
    canDecoder: decoderFor(servohubDbc),
    periodicFrames: periodicFramesOf(servohubDbc, 'STATUS_'),
    // firmware fix, minor, year
    parseFirmwareVersion: (data) => {
      if (data.length < 3) return '0.0.0';
      return `${data.readUInt8(2)}.${data.readUInt8(1)}.${data.readUInt8(0)}`;
    },
  });
  devices.set(deviceKey(MANUFACTURER_REV, ENCODER_ID), {
    name: 'Encoder',
    v1Prefix: 'REV/Encoder-',
    canDecoder: decoderFor(encoderDbc),
    periodicFrames: periodicFramesOf(encoderDbc, 'PERIODIC_FRAME_'),
    parseFirmwareVersion: (data) => {
      if (data.length < 6) return '0.0.0';
      return `${data.readUInt8(5)}.${data.readUInt8(4)}.${data.readUInt8(3)}`;
    },
  });
  devices.set(deviceKey(MANUFACTURER_A301, MOTOR_CONTROLLER_ID), {
    name: 'A301',
    v1Prefix: 'REV/A301-',
    canDecoder: decoderFor(a301Dbc),
    periodicFrames: periodicFramesOf(a301Dbc, 'STATUS_'),
    parseFirmwareVersion: majorMinorBuild,
  });

  const deviceOf = (messageId: number) =>
    devices.get(deviceKey((messageId >> 16) & 0xff, (messageId >> 24) & 0x1f));

  // --- File state ---
  let formatVersion = 0; // 1 or 2 once known
  const busNames = new Map<number, string>();
  let lastTimestampUs = 0n;
  const droppedTotals = new Map<number, bigint>();

  const busName = (bus: number) => busNames.get(bus) ?? `CAN_${bus}`;

  // Entry name prefix for a device, for example "REV/CAN_S0/Spark-3"
  const devicePath = (device: Device, bus: number, deviceNumber: number) =>
    formatVersion >= 2
      ? `REV/${busName(bus)}/${device.name}-${deviceNumber}`
      : `${device.v1Prefix}${deviceNumber}`;

  const writeFirmware = (bus: number, messageId: number, data: Buffer) => {
    const device = deviceOf(messageId);
    if (!device) return;
    const name = `${devicePath(device, bus, messageId & 0x3f)}/FIRMWARE`;
    // v1 firmware tables carry no time; v2 uses the latest time seen
    const timestampUs = formatVersion >= 2 ? lastTimestampUs : 0n;
    writeIfChanged(
      name,
      'string',
      device.parseFirmwareVersion(data),
      timestampUs
    );
  };

  const writeFrame = (
    bus: number,
    messageId: number,
    canData: Buffer,
    timestampUs: bigint
  ) => {
    const device = deviceOf(messageId);
    if (!device || !device.canDecoder) return;

    const frameIndex = (messageId >> 6) & 0xf;
    const messageSpec = device.periodicFrames.get(frameIndex);
    if (!messageSpec) return;

    let alignedData = canData;
    if (canData.length < messageSpec.dlc) {
      alignedData = Buffer.concat([
        canData,
        Buffer.alloc(messageSpec.dlc - canData.length),
      ]);
    }

    try {
      const decoded = device.canDecoder.decode(
        device.canDecoder.createFrame(messageSpec.id, alignedData)
      );
      if (!decoded) return;

      let sigIndex = 0; // Track the index manually
      for (const sig of decoded) {
        // Unique numeric key per bus, message and signal
        const fastKey = (bus * 0x20000000 + messageId) * 256 + sigIndex;

        let recordInfo = FAST_RECORDS.get(fastKey);

        // SLOW PATH: We have never seen this signal before.
        // Do the string math, register it, and cache it.
        if (!recordInfo) {
          const signalSpec = messageSpec.signals.get(sig.name);
          if (!signalSpec) {
            sigIndex++;
            continue;
          }

          const folder = sig.name.endsWith('FAULT')
            ? '/FAULT/'
            : sig.name.endsWith('WARNING')
              ? '/WARNING/'
              : '/';
          const name = `${devicePath(device, bus, messageId & 0x3f)}${folder}${sig.name}`;

          const wpilogType = getWpilogTypeFromSignal(signalSpec);
          const metadata = signalSpec.description ?? signalSpec.unit ?? '';

          const newId = NEXT_RECORD_ID++;
          writeControlRecord(newId, name, wpilogType, metadata);

          // Save it to the fast cache
          recordInfo = { id: newId, type: wpilogType };
          FAST_RECORDS.set(fastKey, recordInfo);
        }

        // FAST PATH: Write immediately using the cached info. No strings attached!
        writeRecordFast(recordInfo, sig.value, timestampUs);

        sigIndex++;
      }
    } catch (e) {
      /* ignore decode errors */
    }
  };

  // --- Record handlers ---
  const readShortString = (data: Buffer, cursor: number): [string, number] => {
    const n = data.readUInt8(cursor);
    return [
      data.subarray(cursor + 1, cursor + 1 + n).toString('utf-8'),
      cursor + 1 + n,
    ];
  };

  const handleHeader = (payload: Buffer) => {
    if (payload.length < 8 || payload.toString('ascii', 0, 6) !== 'REVLOG') {
      throw new Error('Corrupted file: invalid REVLOG header.');
    }
    const major = payload.readUInt8(6);
    const minor = payload.readUInt8(7);
    if (major > SUPPORTED_REVLOG_MAJOR_VERSION) {
      throw new Error(
        `This REVLOG uses format version ${major}.${minor}, which this ` +
          `converter can't read. Update @rev-robotics/revlog-converter ` +
          `(or AdvantageScope) to open it.`
      );
    }
    formatVersion = major;
    if (payload.length >= 16) lastTimestampUs = payload.readBigUInt64LE(8);
  };

  const handleV1Persistent = (payload: Buffer) => {
    for (let pc = 0; pc + 10 <= payload.length; pc += 10) {
      writeFirmware(
        0,
        payload.readUInt32LE(pc),
        payload.subarray(pc + 4, pc + 10)
      );
    }
  };

  const handleV1Periodic = (payload: Buffer) => {
    for (let pc = 0; pc + 16 <= payload.length; pc += 16) {
      const timestampUs = BigInt(payload.readUInt32LE(pc)) * 1000n;
      writeFrame(
        0,
        payload.readUInt32LE(pc + 4),
        payload.subarray(pc + 8, pc + 16),
        timestampUs
      );
    }
  };

  const handleBusTable = (payload: Buffer) => {
    let pc = 0;
    while (pc + 2 <= payload.length) {
      const bus = payload.readUInt8(pc);
      const [name, next] = readShortString(payload, pc + 1);
      busNames.set(bus, name);
      pc = next;
    }
  };

  const handleFirmware = (payload: Buffer) => {
    let pc = 0;
    while (pc + 6 <= payload.length) {
      const bus = payload.readUInt8(pc);
      const messageId = payload.readUInt32LE(pc + 1);
      const n = payload.readUInt8(pc + 5);
      if (pc + 6 + n > payload.length) break;
      writeFirmware(bus, messageId, payload.subarray(pc + 6, pc + 6 + n));
      pc += 6 + n;
    }
  };

  const handleFrames = (payload: Buffer) => {
    if (payload.length < 9) return;
    const base = payload.readBigUInt64LE(0);
    const bus = payload.readUInt8(8);
    let pc = 9;
    while (pc + 7 <= payload.length) {
      const timestampUs = base + BigInt(payload.readUInt16LE(pc));
      const messageId = payload.readUInt32LE(pc + 2);
      const n = payload.readUInt8(pc + 6);
      if (pc + 7 + n > payload.length) break;
      writeFrame(
        bus,
        messageId,
        payload.subarray(pc + 7, pc + 7 + n),
        timestampUs
      );
      if (timestampUs > lastTimestampUs) lastTimestampUs = timestampUs;
      pc += 7 + n;
    }
  };

  const handleRobotState = (payload: Buffer) => {
    if (payload.length < 16) return;
    const timestampUs = payload.readBigUInt64LE(0);
    const word = payload.readBigUInt64LE(8);
    lastTimestampUs = timestampUs;
    writeIfChanged(
      'DS:controlWord/enabled',
      'boolean',
      ((word >> 58n) & 1n) === 1n,
      timestampUs
    );
    writeIfChanged(
      'DS:controlWord/robotMode',
      'string',
      ROBOT_MODES[Number((word >> 56n) & 3n)],
      timestampUs
    );
  };

  const handleMatchInfo = (payload: Buffer) => {
    if (payload.length < 13) return;
    const timestampUs = payload.readBigUInt64LE(0);
    const [eventName] = readShortString(payload, 12);
    writeIfChanged('DS:matchInfo/eventName', 'string', eventName, timestampUs);
    writeIfChanged(
      'DS:matchInfo/matchType',
      'int64',
      BigInt(payload.readUInt8(8)),
      timestampUs
    );
    writeIfChanged(
      'DS:matchInfo/matchNumber',
      'int64',
      BigInt(payload.readUInt16LE(9)),
      timestampUs
    );
  };

  const handleLoggerEvent = (payload: Buffer) => {
    if (payload.length < 10) return;
    const timestampUs = payload.readBigUInt64LE(0);
    const code = payload.readUInt8(8);
    const [detail] = readShortString(payload, 9);
    const name = LOGGER_EVENTS[code] ?? `event-${code}`;
    writeRecord(
      'REV/StatusLogger/Event',
      'string',
      detail ? `${name}: ${detail}` : name,
      timestampUs
    );
  };

  const handleDiagnostics = (payload: Buffer) => {
    if (payload.length < 8) return;
    const timestampUs = payload.readBigUInt64LE(0);
    for (let pc = 8; pc + 6 <= payload.length; pc += 6) {
      const bus = payload.readUInt8(pc);
      const kind = payload.readUInt8(pc + 1);
      const count = BigInt(payload.readUInt32LE(pc + 2));
      if (kind !== 1) continue; // stream overflow
      const total = (droppedTotals.get(bus) ?? 0n) + count;
      droppedTotals.set(bus, total);
      writeRecord(
        `REV/StatusLogger/${busName(bus)}/DroppedFrames`,
        'int64',
        total,
        timestampUs
      );
    }
  };

  const handleRecord = (entryId: number, payload: Buffer) => {
    // The first record decides the format: v2 files start with a header
    if (formatVersion === 0) {
      formatVersion = entryId === RECORD_HEADER ? 2 : 1;
    }

    if (formatVersion === 1) {
      if (entryId === RECORD_PERSISTENT) {
        recordsProcessed = true;
        handleV1Persistent(payload);
      } else if (entryId === RECORD_PERIODIC) {
        recordsProcessed = true;
        handleV1Periodic(payload);
      }
      return;
    }

    // Version 2: unknown record IDs are skipped
    recordsProcessed = true;
    switch (entryId) {
      case RECORD_HEADER:
        handleHeader(payload);
        break;
      case RECORD_BUS_TABLE:
        handleBusTable(payload);
        break;
      case RECORD_FIRMWARE:
        handleFirmware(payload);
        break;
      case RECORD_FRAMES:
        handleFrames(payload);
        break;
      case RECORD_ROBOT_STATE:
        handleRobotState(payload);
        break;
      case RECORD_MATCH_INFO:
        handleMatchInfo(payload);
        break;
      case RECORD_LOGGER_EVENT:
        handleLoggerEvent(payload);
        break;
      case RECORD_DIAGNOSTICS:
        handleDiagnostics(payload);
        break;
    }
  };

  // --- Write File Header ---
  writeOut(Buffer.from(HEADER, 'utf-8'));
  writeOut(
    (() => {
      const b = Buffer.alloc(6);
      b.writeUInt16LE((VERSION_MAJOR << 8) | VERSION_MINOR, 0);
      b.writeUInt32LE(Buffer.byteLength(EXTRA_HEADER), 2);
      return b;
    })()
  );
  writeOut(Buffer.from(EXTRA_HEADER, 'utf-8'));

  // --- Core Processing Loop ---
  let accumulator = Buffer.alloc(0);

  for await (const chunk of readStream) {
    // Append new chunk to our working buffer
    accumulator = Buffer.concat([accumulator, chunk]);
    let cursor = 0;

    while (cursor < accumulator.length) {
      const bitfield = accumulator[cursor];
      const entryIdLen = (bitfield & 0b11) + 1;
      const sizeLen = ((bitfield >> 2) & 0b11) + 1;

      // 1. Check if we have enough bytes just to read the variable integers
      if (cursor + 1 + entryIdLen + sizeLen > accumulator.length) break;

      let tempCursor = cursor + 1;
      let entryId, payloadSize;

      try {
        [entryId, tempCursor] = readVariableInt(
          accumulator,
          tempCursor,
          entryIdLen
        );
        [payloadSize, tempCursor] = readVariableInt(
          accumulator,
          tempCursor,
          sizeLen
        );

        if (payloadSize > 5 * 1024 * 1024) {
          // 5MB sanity limit
          throw new Error(
            `Corrupted file: unrealistic payload size of ${payloadSize} bytes.`
          );
        }
      } catch (e) {
        break; // Awaiting more data
      }

      // 2. Check if the entire payload is loaded in the accumulator
      if (tempCursor + payloadSize > accumulator.length) break;

      // 3. We have a full, valid record
      handleRecord(
        entryId,
        accumulator.subarray(tempCursor, tempCursor + payloadSize)
      );

      // 4. Advance cursor past this completed record
      cursor = tempCursor + payloadSize;

      if (stagingSize >= 64 * 1024) {
        await flushStaging();
      }
    }

    // 5. Trim the accumulator down to only the unparsed, incomplete data
    if (cursor > 0) {
      accumulator = accumulator.subarray(cursor);
    }

    // 6. Check for backpressure
    await flushStaging();
  }

  if (!recordsProcessed) throw new Error('No valid records found.');

  // --- Cleanup ---
  if (writeStream) {
    // Only close and wait if it's NOT standard output
    if (writeStream !== process.stdout) {
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream!.on('finish', resolve);
        writeStream!.on('error', reject);
      });
    }
    return;
  }
}
