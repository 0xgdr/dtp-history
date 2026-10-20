import { expect, test } from "bun:test";
import { diffChain, diffJson, type ChainState } from "../src/diff.ts";
import type { Json } from "../src/traits.ts";
import { fixture } from "./helpers.ts";

const ID = "TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k";

const base: ChainState = {
  name: "Degen Trash Panda #6872",
  symbol: "DTP",
  uri: `https://arweave.net/${ID}`,
  sellerFeeBasisPoints: 500,
  creators: [
    { address: "A", verified: true, share: 50 },
    { address: "B", verified: false, share: 50 },
  ],
  updateAuthority: "U",
  primarySaleHappened: true,
  isMutable: true,
  collection: null,
};

test("creator changes are cosmetic and labelled", () => {
  const next = { ...base, creators: [{ address: "A", verified: true, share: 100 }, { address: "C", verified: false, share: 0 }] };
  const changes = diffChain(base, next);
  expect(changes.map((c) => [c.path, c.label, c.tag])).toEqual([
    ["creators.A", "creator changed", "cosmetic"],
    ["creators.B", "creator removed", "cosmetic"],
    ["creators.C", "creator added", "cosmetic"],
  ]);
});

test("a URI host move with the same Arweave ID is labelled", () => {
  const [change] = diffChain(base, { ...base, uri: `https://ardrive.net/${ID}` });
  expect(change).toMatchObject({ path: "uri", tag: "cosmetic", label: "URI host move" });
});

test("a URI change to new content is a plain cosmetic change", () => {
  const [change] = diffChain(base, { ...base, uri: "https://arweave.net/wS8w3NFld2wyvTQDyeyiirGMgOD7mrh82wPzxVbXuQY" });
  expect(change).toMatchObject({ path: "uri", tag: "cosmetic" });
  expect(change?.label).toBeUndefined();
});

test("the first step has no diff", () => {
  expect(diffChain(null, base)).toEqual([]);
});

test("❤️ counter change is a cosmetic attribute diff", async () => {
  const a = await fixture<Json>("json-wS8w3NFld2wyvTQDyeyiirGMgOD7mrh82wPzxVbXuQY.json");
  const b = await fixture<Json>("json-dEdDE4RR-nq_MqxJ-c_DOlkHDFwCvP0GmVWlJpVWdrU.json");
  const changes = diffJson(a, b, "same");
  expect(changes).toContainEqual({ path: "attributes.❤️", from: "missing", to: "4", tag: "cosmetic" });
  expect(changes.every((c) => c.tag === "cosmetic")).toBe(true);
});

test("trait and image changes are swaps; re-hosted images are cosmetic", () => {
  const a: Json = { image: "https://x/a.png", attributes: [{ trait_type: "FUR", value: "Red" }] };
  const b: Json = { image: "https://x/b.png", attributes: [{ trait_type: "fur", value: "Gold" }] };
  expect(diffJson(a, b, "different")).toEqual([
    { path: "image", from: "https://x/a.png", to: "https://x/b.png", tag: "swap" },
    { path: "attributes.FUR", from: "Red", to: "Gold", tag: "swap" },
  ]);
  expect(diffJson(a, { ...a, image: "https://x/b.png" }, "rehosted")).toEqual([
    { path: "image", from: "https://x/a.png", to: "https://x/b.png", tag: "cosmetic", label: "image re-hosted" },
  ]);
});

test("a step without JSON on one side has no JSON diff", () => {
  expect(diffJson(null, { image: "x" }, "unknown")).toEqual([]);
});

test("other top-level and properties keys are cosmetic", () => {
  const a: Json = { description: "old", properties: { files: [1], category: "image" } };
  const b: Json = { description: "new", properties: { files: [2], category: "image" } };
  expect(diffJson(a, b, "same").map((c) => [c.path, c.tag])).toEqual([
    ["description", "cosmetic"],
    ["properties.files", "cosmetic"],
  ]);
});
