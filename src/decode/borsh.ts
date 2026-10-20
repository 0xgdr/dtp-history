import { getBase58Decoder } from "@solana/kit";

const base58 = getBase58Decoder();
const utf8 = new TextDecoder("utf-8", { fatal: false });

export class BorshError extends Error {}

// Minimal little-endian Borsh reader. Every read is bounds-checked and throws BorshError.
export class BorshReader {
  offset = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(n: number): number {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new BorshError(`read of ${n} bytes at ${this.offset} overruns buffer of ${this.bytes.length}`);
    }
    const at = this.offset;
    this.offset += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new BorshError(`invalid bool ${v} at ${this.offset - 1}`);
    return v === 1;
  }

  fixed(n: number): Uint8Array {
    const at = this.take(n);
    return this.bytes.subarray(at, at + n);
  }

  pubkey(): string {
    return base58.decode(this.fixed(32));
  }

  string(): string {
    return utf8.decode(this.fixed(this.u32()));
  }

  option<T>(read: (r: BorshReader) => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return read(this);
    throw new BorshError(`invalid option tag ${tag} at ${this.offset - 1}`);
  }

  vec<T>(read: (r: BorshReader) => T): T[] {
    const len = this.u32();
    // Every element is at least one byte, so a length beyond what's left is corrupt data.
    if (len > this.remaining) throw new BorshError(`vec length ${len} exceeds remaining ${this.remaining}`);
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(read(this));
    return out;
  }
}

export function stripNulls(s: string): string {
  return s.replace(/\0+$/, "");
}
