import { describe, expect, test } from "bun:test";
import type { Change } from "../src/diff.ts";
import { addsExalted, exaltedNames, exaltedVerdict } from "../src/exalted.ts";

const stat = (value: string) => ({ attributes: [{ trait_type: "EXALTED_STAT", value }] });
const art: Change = { path: "image", from: "a.png", to: "b.png", tag: "swap" };
const oldForm: Change = { path: "attributes.TELL_ME_A_JOKE", from: "missing", to: "Mint Date", tag: "cosmetic" };
const renamed: Change[] = [
  { path: "attributes.TELL_ME_A_JOKE", from: "Mint Date", to: "missing", tag: "cosmetic" },
  { path: "attributes.EXALTED_STAT", from: "missing", to: "TELL_ME_A_JOKE: Mint Date", tag: "cosmetic" },
];

// Shaped like #55: mint, then the art changes in the update that adds the old-form stat, then
// the stat moves into EXALTED_STAT.
const exaltedHistory = [
  { blockTime: 1637539200, json: { attributes: [] }, diff: [] },
  { blockTime: 1637625600, json: { attributes: [{ trait_type: "TELL_ME_A_JOKE", value: "Mint Date" }] }, diff: [art, oldForm] },
  { blockTime: 1637884800, json: stat("TELL_ME_A_JOKE: Mint Date"), diff: renamed },
];

describe("exalted", () => {
  test("stat names come from EXALTED_STAT values", () => {
    expect(exaltedNames([stat("TELL_ME_A_JOKE: Mint Date"), stat("EXILED: Just kidding."), null])).toEqual(
      new Set(["TELL_ME_A_JOKE", "EXILED"]),
    );
  });

  test("adding the stat in either form counts; renaming doesn't add", () => {
    const names = new Set(["TELL_ME_A_JOKE"]);
    expect(addsExalted([oldForm], names)).toBe(true);
    expect(addsExalted([renamed[1]!], names)).toBe(true);
    expect(addsExalted([{ path: "attributes.❤️", from: "missing", to: "1", tag: "cosmetic" }], names)).toBe(false);
  });

  test("an art change that came with being exalted gives Exalted, dated to that update", () => {
    expect(exaltedVerdict(exaltedHistory, [{ field: "image" }])).toEqual({ exalted: true, exaltedAt: 1637625600 });
  });

  test("a trait change keeps the swap", () => {
    expect(exaltedVerdict(exaltedHistory, [{ field: "image" }, { field: "FUR" }]).exalted).toBe(false);
  });

  test("a later art change that wasn't an exalt keeps the swap", () => {
    const later = [...exaltedHistory, { blockTime: 1700000000, json: stat("TELL_ME_A_JOKE: Mint Date"), diff: [art] }];
    expect(exaltedVerdict(later, [{ field: "image" }]).exalted).toBe(false);
  });

  test("an art change without any exalt is a swap", () => {
    const plain = [
      { blockTime: 1, json: { attributes: [] }, diff: [] },
      { blockTime: 2, json: { attributes: [] }, diff: [art] },
    ];
    expect(exaltedVerdict(plain, [{ field: "image" }]).exalted).toBe(false);
  });
});
