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

export interface BoundSignal {
  signal: Signal;
  value: number | bigint;
  rawValue: number | bigint;
}

export interface DecodedMessage {
  id: number;
  name: string;
  boundSignals: Map<string, BoundSignal>;
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

export class CanDecoder {
  database: Dbc | null = null;

  createFrame(
    id: number,
    data: number[] | Buffer
  ): { id: number; data: Buffer } {
    return { id, data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
  }

  decode(frame: { id: number; data: Buffer }): DecodedMessage | null {
    if (!this.database) throw new Error('DBC Database not loaded.');
    const message = this.database.messagesById.get(frame.id);
    if (!message) return null;

    let data = frame.data;
    // Pad buffer to message length if short, or to 8 bytes for safe BigInt reading
    const neededLength = Math.max(message.dlc, 8);
    if (data.length < neededLength) {
      data = Buffer.concat([data, Buffer.alloc(neededLength - data.length)]);
    }

    const boundSignals = new Map<string, BoundSignal>();
    // Safe read of 64 bits for bitmasking
    const bufferAsBigInt = data.readBigUInt64LE(0);

    for (const signal of message.signals.values()) {
      let rawValue: number | bigint = 0;
      let physicalValue: number | bigint = 0;

      if (signal.dataType === 'float' || signal.dataType === 'double') {
        const byteOffset = Math.floor(signal.startBit / 8);
        const isDouble = signal.dataType === 'double' || signal.length === 64;

        if (isDouble) {
          physicalValue = data.readDoubleLE(byteOffset);
        } else {
          physicalValue = data.readFloatLE(byteOffset);
        }
        rawValue = physicalValue;
      } else {
        if (signal.isLittleEndian) {
          const mask = (1n << BigInt(signal.length)) - 1n;
          const shift = BigInt(signal.startBit);
          let rawBig = (bufferAsBigInt >> shift) & mask;

          if (signal.isSigned) {
            const signBit = 1n << BigInt(signal.length - 1);
            if ((rawBig & signBit) !== 0n) {
              rawBig = rawBig - (1n << BigInt(signal.length));
            }
          }
          rawValue = rawBig;
          if (signal.factor === 1 && signal.offset === 0) {
            physicalValue = rawBig;
          } else {
            physicalValue = Number(rawBig) * signal.factor + signal.offset;
          }
        } else {
          // Basic Big Endian support for Firmware Version Build Number
          if (signal.startBit % 8 === 7 && signal.length === 16) {
            physicalValue = 0;
          }
        }
      }

      if (
        typeof physicalValue === 'number' &&
        (signal.min !== 0 || signal.max !== 0)
      ) {
        if (physicalValue < signal.min) physicalValue = signal.min;
        if (physicalValue > signal.max) physicalValue = signal.max;
      }

      boundSignals.set(signal.name, { signal, value: physicalValue, rawValue });
    }

    return { id: message.id, name: message.name, boundSignals };
  }
}
