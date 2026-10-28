import { describe, expect, test } from "bun:test";
import { DTP_COLLECTION_MINT, DTP_CREATORS } from "../src/constants.ts";
import { buildIndex, pandaNumber, parseInput, resolve, type DasAsset } from "../src/index-lookup.ts";

const asset = (id: string, name: string, extra: Partial<DasAsset> = {}): DasAsset => ({
  id,
  content: { metadata: { name } },
  grouping: [{ group_key: "collection", group_value: DTP_COLLECTION_MINT }],
  ...extra,
});

describe("pandaNumber", () => {
  test("parses names, with padding and whitespace", () => {
    expect(pandaNumber("Degen Trash Panda #6872")).toBe(6872);
    expect(pandaNumber("Degen Trash Panda #6872\0\0\0")).toBe(6872);
    expect(pandaNumber("  Degen Trash Panda #12 ")).toBe(12);
  });

  test("rejects other names", () => {
    expect(pandaNumber("Degen Trash Panda #6872 (copy)")).toBeNull();
    expect(pandaNumber("Trash Panda #1")).toBeNull();
    expect(pandaNumber(null)).toBeNull();
  });
});

describe("parseInput", () => {
  test("accepts #, spaces and leading zeros", () => {
    for (const raw of ["6872", "#6872", " 6872 ", "006872", "# 6872"]) {
      expect(parseInput(raw)).toEqual({ type: "number", n: 6872 });
    }
  });

  test("accepts a base58 mint", () => {
    expect(parseInput("p1kGTLmPty2LxRn5MG5AqqPJQQaxmALzQPQ7xc4bUrf")).toEqual({
      type: "mint",
      mint: "p1kGTLmPty2LxRn5MG5AqqPJQQaxmALzQPQ7xc4bUrf",
    });
  });

  test("rejects everything else", () => {
    for (const raw of ["", "0", "abc", "68 72", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"]) {
      expect(parseInput(raw)).toEqual({ type: "invalid" });
    }
  });
});

describe("buildIndex", () => {
  const index = buildIndex(
    [
      asset("m1", "Degen Trash Panda #1"),
      asset("m3a", "Degen Trash Panda #3"),
      asset("m3b", "Degen Trash Panda #3"),
      asset("m4", "Degen Trash Panda #4\0\0", { burnt: true }),
      asset("m6", "Degen Trash Panda #6"),
      asset("odd", "Some Other Thing"),
      asset("foreign", "Degen Trash Panda #2", { grouping: [{ group_key: "collection", group_value: "Elsewhere" }] }),
      asset("fake", "Degen Trash Panda #2", {
        grouping: [],
        creators: [{ address: DTP_CREATORS[0], verified: false }],
      }),
      // Like #5642: collection points elsewhere, unverified, but the DTP creator is verified.
      asset("m7", "Degen Trash Panda #7", {
        grouping: [],
        creators: [{ address: DTP_CREATORS[0], verified: true }],
      }),
      // Like #14162: second mint, collection field wrong.
      asset("m8", "Degen Trash Panda #8", {
        grouping: [],
        creators: [{ address: DTP_CREATORS[1], verified: true }],
      }),
      // Like #13868: second mint, collection field wrong, burned. Only burnt searchAssets returns it.
      asset("m9", "Degen Trash Panda #9", {
        grouping: [],
        creators: [{ address: DTP_CREATORS[1], verified: true }],
        burnt: true,
      }),
      // Returned by both getAssetsByGroup and getAssetsByCreator.
      asset("m6", "Degen Trash Panda #6", { creators: [{ address: DTP_CREATORS[0], verified: true }] }),
    ],
    DTP_COLLECTION_MINT,
    DTP_CREATORS,
    "2026-10-20T00:00:00.000Z",
  );

  test("sorts assets into pandas, duplicates, burned, missing and unparsed", () => {
    expect(index.pandas).toEqual({ "1": "m1", "6": "m6", "7": "m7", "8": "m8" });
    expect(index.duplicates).toEqual({ "3": ["m3a", "m3b"] });
    expect(index.burned).toEqual({ "4": "m4", "9": "m9" });
    expect(index.missing).toEqual([2, 5]);
    expect(index.unparsed).toEqual([{ mint: "odd", name: "Some Other Thing" }]);
    expect(index.count).toBe(4);
  });

  test("resolve covers every case", () => {
    expect(resolve(index, 1)).toEqual({ kind: "found", mint: "m1" });
    expect(resolve(index, 3)).toEqual({ kind: "duplicate", candidates: ["m3a", "m3b"] });
    expect(resolve(index, 4)).toEqual({ kind: "burned", mint: "m4" });
    expect(resolve(index, 5)).toEqual({ kind: "missing" });
    expect(resolve(index, 99)).toEqual({ kind: "unknown" });
  });
});
