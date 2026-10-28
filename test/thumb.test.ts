import { describe, expect, test } from "bun:test";
import { memoryCache } from "../src/cache.ts";
import { createThumbs } from "../src/thumb.ts";
import { thumbSourceOk } from "../src/thumb-source.ts";

const SRC = "https://arweave.net/abc";
const logo = await Bun.file(`${import.meta.dir}/../web/dtp-logo.png`).bytes();

// A fetch that serves the repo's logo PNG and counts calls.
function fakeFetch(status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(status === 200 ? logo : "nope", { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("thumbSourceOk", () => {
  test("only https Arweave and ArDrive", () => {
    expect(thumbSourceOk("https://arweave.net/x")).toBe(true);
    expect(thumbSourceOk("https://www.arweave.net/x?ext=png")).toBe(true);
    expect(thumbSourceOk("https://ardrive.net/x")).toBe(true);
    for (const bad of ["http://arweave.net/x", "https://evil.example/x", "https://arweave.net.evil.example/x", "file:///etc/passwd", "nope"]) {
      expect(thumbSourceOk(bad)).toBe(false);
    }
  });
});

describe("thumbs", () => {
  test("makes a small WebP, caches it, and serves the cached copy without fetching again", async () => {
    const cache = memoryCache();
    const { fetchImpl, calls } = fakeFetch();
    const thumb = createThumbs({ cache, fetchImpl });

    const first = await thumb(SRC);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("cache-control")).toContain("immutable");
    const bytes = await first.bytes();
    const { width, height, format } = await new Bun.Image(bytes).metadata();
    expect(format).toBe("webp");
    expect(Math.max(width, height)).toBeLessThanOrEqual(400);

    const second = await thumb(SRC);
    expect(await second.bytes()).toEqual(bytes);
    expect(calls).toEqual([SRC]);
  });

  test("concurrent requests share one fetch", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const thumb = createThumbs({ cache: memoryCache(), fetchImpl });
    const [a, b] = await Promise.all([thumb(SRC), thumb(SRC)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(calls).toHaveLength(1);
  });

  test("a bad src is a 400 and fetches nothing", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const thumb = createThumbs({ cache: memoryCache(), fetchImpl });
    expect((await thumb("https://evil.example/x.png")).status).toBe(400);
    expect((await thumb(null)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a failed source is a 502 that isn't cached, so it's tried again", async () => {
    const cache = memoryCache();
    const failing = fakeFetch(404);
    const res = await createThumbs({ cache, fetchImpl: failing.fetchImpl })(SRC);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await cache.getBytes("thumb", new Bun.CryptoHasher("sha256").update(SRC).digest("hex"))).toBeNull();
  });
});
