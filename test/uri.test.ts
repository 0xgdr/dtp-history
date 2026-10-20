import { expect, test } from "bun:test";
import { displayUrl, gatewayUrls, normalizeUri } from "../src/uri.ts";

const ID = "TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k";

test("Arweave gateway variants share one canonical key", () => {
  for (const url of [
    `https://www.arweave.net/${ID}?ext=png`,
    `https://arweave.net/${ID}/`,
    `https://ardrive.net/${ID}`,
    `https://ARWEAVE.net/${ID}#frag`,
    `https://ar-io.net/${ID}`,
    `https://abc123.arweave.net/${ID}`,
    `https://arweave.net/${ID}\0\0`,
  ]) {
    expect(normalizeUri(url).key).toBe(`ar:${ID}`);
  }
});

test("non-Arweave URLs keep their own normalized key", () => {
  expect(normalizeUri("https://Example.com/meta/1.json?x=1").key).toBe("https://example.com/meta/1.json");
  expect(normalizeUri(`https://example.com/${ID}`).key).toBe(`https://example.com/${ID}`);
});

test("gateway fallback order", () => {
  expect(gatewayUrls(`https://ardrive.net/${ID}`)).toEqual([
    `https://ardrive.net/${ID}`,
    `https://arweave.net/${ID}`,
  ]);
  expect(gatewayUrls("https://example.com/a.json")).toEqual(["https://example.com/a.json"]);
});

test("display URLs rewrite ar: keys", () => {
  expect(displayUrl(`ar:${ID}`)).toBe(`https://arweave.net/${ID}`);
});
