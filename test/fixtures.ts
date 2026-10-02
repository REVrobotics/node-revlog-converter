// Deterministic REVLOG fixtures built from the format specs
import { Writable } from 'stream';
import { parseREVLOG } from '../src/lib/revlogParser.js';
import { v1Periodic, v1Persistent } from './helpers.js';

export const kSparkStatus0 = 0x205b800;
export const kSparkStatus1 = 0x205b840;
export const kSparkStatus2 = 0x205b880;
export const kSparkFirmware = 0x2052600;
export const kServoHubStatus0 = 0xc05b800;
export const kServoHubFirmware = 0xc052600;
export const kEncoderFrame2 = 0x705b880;
export const kEncoderVersion = 0x7053840;
export const kA301Status0 = 0x203b800;
export const kA301Firmware = 0x2033800;

// A v1 file like a 2026 robot writes: firmware tables repeated every loop,
// status frames from a SPARK (3), a Servo Hub (1) and an encoder (9)
export const v1Fixture = (): Buffer => {
  const firmware = v1Persistent([
    { id: kSparkFirmware | 3, data: [25, 0, 0, 4, 0, 0x45] },
    { id: kServoHubFirmware | 1, data: [2, 1, 25, 0, 1, 0] },
    { id: kEncoderVersion | 9, data: [0, 1, 2, 3, 1, 26] },
  ]);
  const bytes: number[] = [];
  for (let loop = 0; loop < 4; loop++) {
    const ms = 1000 + loop * 25;
    bytes.push(...firmware, ...firmware, ...firmware);
    bytes.push(
      ...v1Periodic([
        {
          ms,
          id: kSparkStatus0 | 3,
          data: [0x10, 0x27, 0xc8, 0x00, 0x96, 0x11, 0x2c, 0x01],
        },
        {
          ms: ms + 1,
          id: kSparkStatus2 | 3,
          data: [0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0x41],
        },
        {
          ms: ms + 2,
          id: kServoHubStatus0 | 1,
          data: [0x30, 0x11, 0x05, 0x00, 0x00],
        },
        {
          ms: ms + 3,
          id: kEncoderFrame2 | 9,
          data: [0, 0, 0x80, 0x3f, 0, 0, 0, 0x40],
        },
      ])
    );
    if (loop === 2) {
      bytes.push(
        ...v1Periodic([
          { ms: ms + 4, id: kSparkStatus1 | 3, data: [1, 0, 0, 0, 0, 0, 0, 0] },
        ])
      );
    }
  }
  return Buffer.from(bytes);
};

// Converts in memory and returns the WPILOG bytes
export const convert = async (input: Buffer): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await parseREVLOG(input, sink);
  return Buffer.concat(chunks);
};
