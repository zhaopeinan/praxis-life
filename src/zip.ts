import { deflateRawSync } from "node:zlib";

// 最小 ZIP 写入器：够导出用即可，只实现 32 位 ZIP（单文件 / 总量 < 4GB，条目 < 65535）。
// 名称一律按 UTF-8 存并置通用标志位 bit 11，中文文件名在 macOS / Windows / unzip 下都能正常展开。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, date: day };
}

export class ZipBuilder {
  private readonly chunks: Uint8Array[] = [];
  private readonly central: Buffer[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private count = 0;

  constructor(private readonly now: Date = new Date()) {}

  /** 追加一个文件；同名文件会直接报错，调用方应先做去重。 */
  addFile(name: string, data: Uint8Array | string, date?: Date): void {
    if (!name || name.startsWith("/") || name.includes("..") || name.endsWith("/")) {
      throw new Error(`非法 ZIP 条目名：${name}`);
    }
    if (this.names.has(name)) throw new Error(`ZIP 条目重名：${name}`);
    this.names.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    const raw: Uint8Array = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const crc = crc32(raw);
    let method = 8;
    let payload: Uint8Array = deflateRawSync(raw);
    if (payload.length >= raw.length) {
      method = 0;
      payload = raw;
    }
    const stamp = dosDateTime(date ?? this.now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    this.chunks.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(this.offset, 42);
    this.central.push(Buffer.concat([central, nameBytes]));

    this.offset += local.length + nameBytes.length + payload.length;
    this.count += 1;
  }

  finish(): Buffer<ArrayBuffer> {
    const centralSize = this.central.reduce((total, chunk) => total + chunk.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // disk number
    end.writeUInt16LE(0, 6); // central directory disk
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20); // comment length
    return Buffer.concat([...this.chunks, ...this.central, end]);
  }
}
