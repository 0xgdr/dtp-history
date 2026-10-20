import { flattenTransaction, type FlatTransaction, type RawTransaction } from "../src/tx.ts";

export const MINT_6872 = "p1kGTLmPty2LxRn5MG5AqqPJQQaxmALzQPQ7xc4bUrf";
export const PDA_6872 = "Etoow3nboS5RqzCbVCGNAUMr5aRfbzQJiN6y11q3py9Z";

const DIR = `${import.meta.dir}/fixtures/6872`;

export async function fixture<T = unknown>(name: string): Promise<T> {
  return Bun.file(`${DIR}/${name}`).json();
}

export async function rawTx(stamp: string): Promise<RawTransaction> {
  return fixture<RawTransaction>(`tx-${stamp}.json`);
}

export async function flatTx(stamp: string): Promise<FlatTransaction> {
  return flattenTransaction(await rawTx(stamp));
}

// Builds a FlatTransaction around one hand-made instruction.
export function syntheticTx(programId: string, accounts: string[], data: Uint8Array): FlatTransaction {
  return {
    sig: "synthetic",
    slot: 1,
    blockTime: 0,
    failed: false,
    signers: [accounts[1] ?? ""],
    instructions: [{ ixPath: "0", programId, accounts, data }],
  };
}

// Little-endian Borsh writer for building test instructions.
export class BorshWriter {
  private parts: number[] = [];

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }

  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }

  u64(v: bigint): this {
    for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn));
    return this;
  }

  bytes(b: Uint8Array): this {
    this.parts.push(...b);
    return this;
  }

  string(s: string): this {
    const b = new TextEncoder().encode(s);
    return this.u32(b.length).bytes(b);
  }

  build(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}
