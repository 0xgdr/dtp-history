import { describe, expect, test } from "bun:test";
import { getAddressEncoder, address } from "@solana/kit";
import { BorshError, BorshReader, stripNulls } from "../src/decode/borsh.ts";
import { BorshWriter, PDA_6872 } from "./helpers.ts";

describe("BorshReader", () => {
  test("reads integers little-endian", () => {
    const r = new BorshReader(new BorshWriter().u8(7).u16(0x1234).u32(0xdeadbeef).u64(2n ** 63n + 5n).build());
    expect(r.u8()).toBe(7);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.u64()).toBe(2n ** 63n + 5n);
    expect(r.remaining).toBe(0);
  });

  test("reads strings, options, vecs and pubkeys", () => {
    const key = getAddressEncoder().encode(address(PDA_6872));
    const bytes = new BorshWriter()
      .string("Degen Trash Panda #6872")
      .u8(0)
      .u8(1)
      .string("x")
      .u32(2)
      .u8(1)
      .u8(0)
      .bytes(new Uint8Array(key))
      .build();
    const r = new BorshReader(bytes);
    expect(r.string()).toBe("Degen Trash Panda #6872");
    expect(r.option((x) => x.string())).toBeNull();
    expect(r.option((x) => x.string())).toBe("x");
    expect(r.vec((x) => x.bool())).toEqual([true, false]);
    expect(r.pubkey()).toBe(PDA_6872);
  });

  test("out-of-bounds reads throw BorshError", () => {
    expect(() => new BorshReader(new Uint8Array([1])).u16()).toThrow(BorshError);
    expect(() => new BorshReader(new BorshWriter().u32(100).build()).string()).toThrow(BorshError);
    expect(() => new BorshReader(new BorshWriter().u32(1_000_000).build()).vec((x) => x.u8())).toThrow(BorshError);
  });

  test("invalid option tags and bools throw", () => {
    expect(() => new BorshReader(new Uint8Array([2])).option((x) => x.u8())).toThrow(BorshError);
    expect(() => new BorshReader(new Uint8Array([9])).bool()).toThrow(BorshError);
  });
});

test("stripNulls removes trailing padding only", () => {
  expect(stripNulls("Degen Trash Panda #6872\0\0\0")).toBe("Degen Trash Panda #6872");
  expect(stripNulls("a\0b")).toBe("a\0b");
});
