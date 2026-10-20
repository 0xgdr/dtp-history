import { expect, test } from "bun:test";
import { memoryCache } from "../src/cache.ts";
import { createFetcher } from "../src/json-fetch.ts";

const ID = "TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k";

function fakeFetch(responses: Record<string, () => Response>) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const make = responses[url];
    if (!make) throw new Error(`network error for ${url}`);
    return make();
  }) as typeof fetch;
  return { impl, seen };
}

test("falls back to the next gateway and caches by canonical key", async () => {
  const { impl, seen } = fakeFetch({
    [`https://arweave.net/${ID}`]: () => Response.json({ name: "ok" }),
  });
  const cache = memoryCache();
  const fetcher = createFetcher(cache, impl);
  expect(await fetcher.json(`https://ardrive.net/${ID}`)).toEqual({ json: { name: "ok" }, error: null });
  // The original URL is tried twice before falling back.
  expect(seen).toEqual([`https://ardrive.net/${ID}`, `https://ardrive.net/${ID}`, `https://arweave.net/${ID}`]);
  expect(await cache.get("json", `ar:${ID}`)).toEqual({ name: "ok" });

  // A different host for the same ID is served from the cache.
  seen.length = 0;
  expect((await fetcher.json(`https://www.arweave.net/${ID}?ext=json`)).json).toEqual({ name: "ok" });
  expect(seen).toEqual([]);
});

test("failures return an error and are not cached", async () => {
  const { impl } = fakeFetch({ "https://example.com/a.json": () => new Response("nope", { status: 500 }) });
  const cache = memoryCache();
  const result = await createFetcher(cache, impl).json("https://example.com/a.json");
  expect(result.json).toBeNull();
  expect(result.error).toContain("HTTP 500");
  expect(await cache.get("json", "https://example.com/a.json")).toBeNull();
});

test("oversized responses are rejected", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  const { impl } = fakeFetch({ "https://example.com/big.json": () => new Response(`"${big}"`) });
  const result = await createFetcher(memoryCache(), impl).json("https://example.com/big.json");
  expect(result.error).toContain("larger than");
});

test("image hashes compare bytes", async () => {
  const { impl } = fakeFetch({
    "https://example.com/a.png": () => new Response(new Uint8Array([1, 2, 3])),
    "https://example.com/b.png": () => new Response(new Uint8Array([1, 2, 3])),
  });
  const fetcher = createFetcher(memoryCache(), impl);
  const [a, b] = await Promise.all([fetcher.imageHash("https://example.com/a.png"), fetcher.imageHash("https://example.com/b.png")]);
  expect(a).toBe(b);
  expect(a).toHaveLength(64);
  expect(await fetcher.imageHash("https://example.com/missing.png")).toBeNull();
});
