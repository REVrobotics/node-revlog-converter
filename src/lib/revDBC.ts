import { Buffer } from 'buffer';

export interface Signal {
  name: string;
  startBit: number;
  length: number;
  isLittleEndian: boolean;
  isSigned: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  description?: string;
  dataType: 'int' | 'float' | 'double';
}

export interface Message {
  id: number;
  name: string;
  dlc: number;
  sender: string;
  signals: Map<string, Signal>;
}

export class Dbc {
  messages: Map<string, Message> = new Map();
  messagesById: Map<number, Message> = new Map();

  load(content: string): Dbc {
    const lines = content.split(/\r?\n/);
    let currentMessage: Message | null = null;

    const reBO = /^BO_\s+(\d+)\s+(\w+):\s*(\d+)\s+(\w+)/;
    const reSG =
      /^\s*SG_\s+(\w+)\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)\s*\[\s*([\d.-]+)\s*\|\s*([\d.-]+)\s*\]\s*"(.*?)"/;
    const reValType = /^\s*SIG_VALTYPE_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s*;/;
    const reComment = /^\s*CM_\s+SG_\s+(\d+)\s+(\w+)\s*"(.*)";/;

    for (const line of lines) {
      const matchBO = line.match(reBO);
      if (matchBO) {
        const id = parseInt(matchBO[1], 10);
        currentMessage = {
          id,
          name: matchBO[2],
          dlc: parseInt(matchBO[3], 10),
          sender: matchBO[4],
          signals: new Map(),
        };
        this.messages.set(currentMessage.name, currentMessage);
        this.messagesById.set(id, currentMessage);
        continue;
      }

      const matchSG = line.match(reSG);
      if (matchSG && currentMessage) {
        const name = matchSG[1];
        const signal: Signal = {
          name,
          startBit: parseInt(matchSG[2], 10),
          length: parseInt(matchSG[3], 10),
          isLittleEndian: matchSG[4] === '1',
          isSigned: matchSG[5] === '-',
          factor: parseFloat(matchSG[6]),
          offset: parseFloat(matchSG[7]),
          min: parseFloat(matchSG[8]),
          max: parseFloat(matchSG[9]),
          unit: matchSG[10],
          dataType: 'int',
        };
        currentMessage.signals.set(name, signal);
        continue;
      }

      const matchValType = line.match(reValType);
      if (matchValType) {
        const msg = this.messagesById.get(parseInt(matchValType[1], 10));
        const sig = msg?.signals.get(matchValType[2]);
        if (sig) {
          if (matchValType[3] === '1') sig.dataType = 'float';
          if (matchValType[3] === '2') sig.dataType = 'double';
        }
        continue;
      }

      const matchComment = line.match(reComment);
      if (matchComment) {
        const msg = this.messagesById.get(parseInt(matchComment[1], 10));
        const sig = msg?.signals.get(matchComment[2]);
        if (sig) sig.description = matchComment[3];
      }
    }
    return this;
  }
}

export interface DecodedSignal {
  name: string;
  value: number | bigint;
}

export class CanDecoder {
  database: Dbc | null = null;

  // A reusable pool of signal objects. This prevents V8 from creating
  // and destroying millions of objects during massive log parses.
  private resultCache: DecodedSignal[] = [];

  createFrame(
    id: number,
    data: number[] | Buffer
  ): { id: number; data: Buffer } {
    return { id, data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
  }

  decode(frame: { id: number; data: Buffer }): DecodedSignal[] | null {
    if (!this.database) throw new Error('DBC Database not loaded.');
    const message = this.database.messagesById.get(frame.id);
    if (!message) return null;

    let data = frame.data;
    const neededLength = Math.max(message.dlc, 8);
    if (data.length < neededLength) {
      data = Buffer.concat([data, Buffer.alloc(neededLength - data.length)]);
    }

    let resultIndex = 0;

    for (const signal of message.signals.values()) {
      let physicalValue: number | bigint = 0;

      if (signal.dataType === 'float' || signal.dataType === 'double') {
        const byteOffset = Math.floor(signal.startBit / 8);
        const isDouble = signal.dataType === 'double' || signal.length === 64;

        // Ensure we don't read past the buffer if floats are misaligned
        if (byteOffset + (isDouble ? 8 : 4) <= data.length) {
          physicalValue = isDouble
            ? data.readDoubleLE(byteOffset)
            : data.readFloatLE(byteOffset);
        }
      } else {
        if (signal.isLittleEndian) {
          // Dynamic offset allows reading signals past the 64th bit (CAN FD)
          const byteStart = Math.floor(signal.startBit / 8);
          const bitStart = signal.startBit % 8;

          let rawBig = 0n;
          for (let i = 0; i < 8 && byteStart + i < data.length; i++) {
            rawBig |= BigInt(data[byteStart + i]) << BigInt(i * 8);
          }

          rawBig =
            (rawBig >> BigInt(bitStart)) & ((1n << BigInt(signal.length)) - 1n);

          if (signal.isSigned) {
            const signBit = 1n << BigInt(signal.length - 1);
            if ((rawBig & signBit) !== 0n) {
              rawBig = rawBig - (1n << BigInt(signal.length));
            }
          }

          if (signal.factor === 1 && signal.offset === 0) {
            // Keep precision for massive 64-bit timestamps, otherwise downcast to number for speed
            physicalValue =
              rawBig <= Number.MAX_SAFE_INTEGER &&
              rawBig >= Number.MIN_SAFE_INTEGER
                ? Number(rawBig)
                : rawBig;
          } else {
            physicalValue = Number(rawBig) * signal.factor + signal.offset;
          }
        } else {
          // Robust Motorola (Big-Endian) Sawtooth Decoding
          let rawBig = 0n;
          let currentBit = signal.startBit;

          for (let i = 0; i < signal.length; i++) {
            const byteIdx = Math.floor(currentBit / 8);
            const bitIdx = currentBit % 8;

            if (byteIdx < data.length) {
              const bitVal = (BigInt(data[byteIdx]) >> BigInt(bitIdx)) & 1n;
              rawBig = (rawBig << 1n) | bitVal;
            }

            // Move backwards through the saw-tooth bit matrix
            if (bitIdx === 0) {
              currentBit += 15;
            } else {
              currentBit -= 1;
            }
          }

          if (signal.factor === 1 && signal.offset === 0) {
            physicalValue =
              rawBig <= Number.MAX_SAFE_INTEGER &&
              rawBig >= Number.MIN_SAFE_INTEGER
                ? Number(rawBig)
                : rawBig;
          } else {
            physicalValue = Number(rawBig) * signal.factor + signal.offset;
          }
        }
      }

      // Min/Max clamping
      if (
        typeof physicalValue === 'number' &&
        (signal.min !== 0 || signal.max !== 0)
      ) {
        if (physicalValue < signal.min) physicalValue = signal.min;
        if (physicalValue > signal.max) physicalValue = signal.max;
      }

      // Update the pooled object instead of creating a new one
      if (this.resultCache.length <= resultIndex) {
        this.resultCache.push({ name: signal.name, value: physicalValue });
      } else {
        this.resultCache[resultIndex].name = signal.name;
        this.resultCache[resultIndex].value = physicalValue;
      }

      resultIndex++;
    }

    // Trim the array view if this frame has fewer signals than the previous frame
    this.resultCache.length = resultIndex;
    return this.resultCache;
  }
}
