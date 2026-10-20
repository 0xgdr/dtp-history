import { describe, expect, test } from "bun:test";
import type { Fetcher } from "../src/json-fetch.ts";
import type { Json } from "../src/traits.ts";
import { compareImages, verdict } from "../src/verdict.ts";
import { fixture } from "./helpers.ts";

const MINT_JSON = "json-wS8w3NFld2wyvTQDyeyiirGMgOD7mrh82wPzxVbXuQY.json";

const withAttrs = (json: Json, attributes: unknown[]): Json => ({ ...json, attributes });
const attrs = (json: Json) => json.attributes as { trait_type: string; value: unknown }[];

describe("verdict", () => {
  test("identical JSON is Original", async () => {
    const json = await fixture<Json>(MINT_JSON);
    expect(verdict(json, structuredClone(json), "same").verdict).toBe("Original");
  });

  test("shuffled attribute order is Original", async () => {
    const json = await fixture<Json>(MINT_JSON);
    expect(verdict(json, withAttrs(json, [...attrs(json)].reverse()), "same").verdict).toBe("Original");
  });

  test("trait_type casing and whitespace differences are Original", async () => {
    const json = await fixture<Json>(MINT_JSON);
    const shouty = attrs(json).map((a) => ({ trait_type: ` ${a.trait_type.toLowerCase()} `, value: ` ${a.value} ` }));
    expect(verdict(json, withAttrs(json, shouty), "same").verdict).toBe("Original");
  });

  test("❤️ counter change is Original (the real 2021-11-27 -> 2021-11-29 change)", async () => {
    const a = await fixture<Json>("json-dEdDE4RR-nq_MqxJ-c_DOlkHDFwCvP0GmVWlJpVWdrU.json");
    const b = await fixture<Json>("json-HK4b1FL5AdkncwPpN8D0KWUmqsxyVxAITb78t95xLrQ.json");
    expect(verdict(a, b, "same").verdict).toBe("Original");
  });

  test("FUR change is Traits/art changed", async () => {
    const json = await fixture<Json>(MINT_JSON);
    const changed = attrs(json).map((a) => (a.trait_type === "FUR" ? { ...a, value: "Gold" } : a));
    const result = verdict(json, withAttrs(json, changed), "same");
    expect(result.verdict).toBe("Traits/art changed");
    expect(result.changes).toEqual([{ field: "FUR", from: "Red - Grin", to: "Gold" }]);
  });

  test("numeric trait values compare as strings", () => {
    const a = { attributes: [{ trait_type: "HEAD", value: 4 }] };
    const b = { attributes: [{ trait_type: "HEAD", value: "4" }] };
    expect(verdict(a, b, "same").verdict).toBe("Original");
  });

  test("image with different bytes is changed", async () => {
    const json = await fixture<Json>(MINT_JSON);
    const result = verdict(json, { ...json, image: "https://arweave.net/other" }, "different");
    expect(result.verdict).toBe("Traits/art changed");
    expect(result.changes[0]?.field).toBe("image");
  });

  test("image re-hosted with the same bytes is Original", async () => {
    const json = await fixture<Json>(MINT_JSON);
    expect(verdict(json, { ...json, image: "https://example.com/x.png" }, "rehosted").verdict).toBe("Original");
  });

  test("a trait missing from the current JSON is changed", async () => {
    const json = await fixture<Json>(MINT_JSON);
    const result = verdict(json, withAttrs(json, attrs(json).filter((a) => a.trait_type !== "GLASSES")), "same");
    expect(result.verdict).toBe("Traits/art changed");
    expect(result.changes).toEqual([{ field: "GLASSES", from: "No Traits", to: null }]);
  });

  test("mint JSON without any of the six traits is Unknown", () => {
    expect(verdict({ attributes: [{ trait_type: "❤️", value: 1 }] }, { attributes: [] }, "same").verdict).toBe("Unknown");
  });

  test("missing mint or current JSON is Unknown", async () => {
    const json = await fixture<Json>(MINT_JSON);
    expect(verdict(null, json, "same").verdict).toBe("Unknown");
    expect(verdict(json, null, "same").verdict).toBe("Unknown");
  });

  test("equal traits but unknown image check is Unknown", async () => {
    const json = await fixture<Json>(MINT_JSON);
    expect(verdict(json, json, "unknown").verdict).toBe("Unknown");
  });

  test("duplicate trait_type uses the first and warns", () => {
    const a = { attributes: [{ trait_type: "HEAD", value: "A" }, { trait_type: "head", value: "B" }] };
    const result = verdict(a, { attributes: [{ trait_type: "HEAD", value: "A" }] }, "same");
    expect(result.verdict).toBe("Original");
    expect(result.warnings.join()).toContain("duplicate");
  });
});

describe("compareImages", () => {
  const fetcher = (hashes: Record<string, string | null>): Fetcher => ({
    json: async () => ({ json: null, error: "unused" }),
    imageHash: async (uri) => hashes[uri] ?? null,
  });
  const ID = "KCPnIoNva-EubeDnc6vLZRrlfijdEVN5Pi2-pz8f0ZQ";

  test("same canonical key needs no fetch", async () => {
    expect(await compareImages(fetcher({}), `https://www.arweave.net/${ID}?ext=png`, `https://arweave.net/${ID}`)).toBe("same");
  });

  test("different keys compare bytes", async () => {
    const f = fetcher({ a: "h1", b: "h1", c: "h2" });
    expect(await compareImages(f, "a", "b")).toBe("rehosted");
    expect(await compareImages(f, "a", "c")).toBe("different");
    expect(await compareImages(f, "a", "unreachable")).toBe("unknown");
  });
});
