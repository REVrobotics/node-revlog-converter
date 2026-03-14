import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { Readable, Writable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';
import { Dbc, CanDecoder, BoundSignal, Message, Signal } from './revDBC.js';

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

  const writeOut = (data: Buffer) => {
    if (writeStream) {
      writeStream.write(data);
    }
  };
  // --- Constants ---
  const HEADER = 'WPILOG';
  const VERSION_MAJOR = 1;
  const VERSION_MINOR = 0;
  const EXTRA_HEADER = '';

  const SPARK_PREFIX = 'REV/Spark-';
  const MOTOR_CONTROLLER_ID = 2;

  const SERVO_HUB_PREFIX = 'REV/ServoHub-';
  const SERVO_CONTROLLER_ID = 12;

  const ENCODER_PREFIX = 'REV/Encoder-';
  const ENCODER_ID = 7;

  const RECORDS = new Map<string, { id: number; type: string }>();
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

  const writeRecord = (
    entryName: string,
    entryValue: string | number | boolean | bigint,
    timestampMs: number
  ) => {
    const recordInfo = RECORDS.get(entryName);
    if (!recordInfo) return;

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
    const timestampUs = BigInt(timestampMs) * 1000n;
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
    canDecoder: CanDecoder;
    dbc: Dbc;
    prefix: string;
    firmwareFrameId?: number;
    firmwareMessageName?: string;
    periodicFrames: Map<number, Message>;
    parseFirmwareVersion(
      decoded: Map<string, BoundSignal>,
      data?: Buffer
    ): string;
  }

  const sparkDbc = await readDbcFile('spark.public.dbc');
  const servohubDbc = await readDbcFile('servo_hub.public.dbc');
  const encoderDbc = await readDbcFile('encoder.public.dbc');

  const createDeviceMap = (
    dbc: Dbc,
    prefix: string,
    fwName: string,
    periodicPrefix: string = 'STATUS_',
    customVersionParser?: (data: Buffer) => string
  ): Device => ({
    canDecoder: (() => {
      const c = new CanDecoder();
      c.database = dbc;
      return c;
    })(),
    dbc,
    prefix,
    firmwareFrameId: dbc.messages.get(fwName)?.id,
    firmwareMessageName: fwName,
    periodicFrames: new Map(
      [...dbc.messages.values()]
        .filter((m) => m.name.startsWith(periodicPrefix))
        .map((m) => {
          const apiIndex = (m.id >> 6) & 0xf;
          return [apiIndex, m];
        })
    ),
    parseFirmwareVersion: (decoded, data) => {
      if (!data || data.length === 0) return '0.0.0';
      if (customVersionParser) return customVersionParser(data);

      const major = data.length > 0 ? data.readUInt8(0) : 0;
      const minor = data.length > 1 ? data.readUInt8(1) : 0;
      const build = data.length > 3 ? data.readUInt16BE(2) : 0;
      return `${major}.${minor}.${build}`;
    },
  });

  const devices = new Map<number, Device>();

  devices.set(
    MOTOR_CONTROLLER_ID,
    createDeviceMap(sparkDbc, SPARK_PREFIX, 'GET_FIRMWARE_VERSION')
  );
  devices.set(
    SERVO_CONTROLLER_ID,
    createDeviceMap(servohubDbc, SERVO_HUB_PREFIX, 'GET_VERSION')
  );
  devices.set(
    ENCODER_ID,
    createDeviceMap(
      encoderDbc,
      ENCODER_PREFIX,
      'GET_VERSIONING_RESP',
      'PERIODIC_FRAME_',
      (data: Buffer) => {
        if (data.length < 6) return '0.0.0';
        const swMajor = data.readUInt8(5);
        const swMinor = data.readUInt8(4);
        const swFix = data.readUInt8(3);
        return `${swMajor}.${swMinor}.${swFix}`;
      }
    )
  );

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
      } catch (e) {
        break; // Awaiting more data
      }

      // 2. Check if the entire payload is loaded in the accumulator
      if (tempCursor + payloadSize > accumulator.length) break;

      // 3. We have a full, valid record
      const payloadBytes = accumulator.subarray(
        tempCursor,
        tempCursor + payloadSize
      );

      if (entryId === 1) {
        // Firmware
        recordsProcessed = true;
        for (let pc = 0; pc + 10 <= payloadBytes.length; pc += 10) {
          const messageId = payloadBytes.readUInt32LE(pc);
          const canData = payloadBytes.subarray(pc + 4, pc + 10);
          const deviceType = (messageId >> 24) & 0x1f;
          const device = devices.get(deviceType);

          if (device && device.firmwareFrameId) {
            const padded = Buffer.concat([canData, Buffer.alloc(8)]);
            const decoded = device.canDecoder.decode(
              device.canDecoder.createFrame(device.firmwareFrameId, padded)
            );
            if (decoded) {
              const name = `${device.prefix}${messageId & 0x3f}/FIRMWARE`;
              if (!RECORDS.has(name)) {
                writeControlRecord(NEXT_RECORD_ID++, name, 'string', '');
              }
              writeRecord(
                name,
                device.parseFirmwareVersion(decoded.boundSignals, canData),
                0
              );
            }
          }
        }
      } else if (entryId === 2) {
        // Periodic
        recordsProcessed = true;
        for (let pc = 0; pc + 16 <= payloadBytes.length; pc += 16) {
          const msgTsMs = payloadBytes.readUInt32LE(pc);
          const messageId = payloadBytes.readUInt32LE(pc + 4);
          const canData = payloadBytes.subarray(pc + 8, pc + 16);
          const deviceType = (messageId >> 24) & 0x1f;
          const device = devices.get(deviceType);

          if (device) {
            const frameIndex = (messageId >> 6) & 0xf;
            const messageSpec = device.periodicFrames.get(frameIndex);

            if (messageSpec) {
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
                if (decoded) {
                  for (const [
                    signalName,
                    boundSignal,
                  ] of decoded.boundSignals) {
                    const signalSpec = messageSpec.signals.get(signalName);
                    if (!signalSpec) continue;

                    const folder = signalName.endsWith('FAULT')
                      ? '/FAULT/'
                      : signalName.endsWith('WARNING')
                        ? '/WARNING/'
                        : '/';
                    const name = `${device.prefix}${messageId & 0x3f}${folder}${signalName}`;

                    if (!RECORDS.has(name)) {
                      const wpilogType = getWpilogTypeFromSignal(signalSpec);
                      const metadata =
                        signalSpec.description ?? signalSpec.unit ?? '';
                      writeControlRecord(
                        NEXT_RECORD_ID++,
                        name,
                        wpilogType,
                        metadata
                      );
                    }
                    writeRecord(name, boundSignal.value, msgTsMs);
                  }
                }
              } catch (e) {
                /* ignore decode errors */
              }
            }
          }
        }
      }

      // 4. Advance cursor past this completed record
      cursor = tempCursor + payloadSize;
    }

    // 5. Trim the accumulator down to only the unparsed, incomplete data
    if (cursor > 0) {
      accumulator = accumulator.subarray(cursor);
    }
  }

  if (!recordsProcessed) throw new Error('No valid records found.');

  // --- Cleanup ---
  if (writeStream) {
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream!.on('finish', resolve);
      writeStream!.on('error', reject);
    });
    return; // Returns void if writing to a file
  }
}
