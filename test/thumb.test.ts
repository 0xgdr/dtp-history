import { describe, expect, test } from "bun:test";
import { memoryCache } from "../src/cache.ts";
import { createThumbs, sourcesFor } from "../src/thumb.ts";
import { thumbSourceOk } from "../src/thumb-source.ts";

const ID = "hE2KlbHN-nhY1t0TlAAEkE0s3-lQ-Umap5T0kGi0m9A";
const SRC = `https://arweave.net/${ID}`;
const ARDRIVE = `https://ardrive.net/${ID}`;
const logo = await Bun.file(`${import.meta.dir}/../web/dtp-logo.png`).bytes();

// A fetch that serves the repo's logo PNG and counts calls; `status` per host (default 200).
function fakeFetch(status: number | Record<string, number> = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const code = typeof status === "number" ? status : (status[new URL(url).host] ?? 200);
    return new Response(code === 200 ? logo : "nope", { status: code });
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

describe("sourcesFor", () => {
  test("an Arweave id is tried on ArDrive first, and the other way round", () => {
    expect(sourcesFor(`${SRC}?ext=png`.replace("arweave.net", "www.arweave.net"))).toEqual([ARDRIVE, `https://www.arweave.net/${ID}?ext=png`]);
    expect(sourcesFor(ARDRIVE)).toEqual([ARDRIVE, SRC]);
  });

  test("anything that isn't a bare id is fetched as is", () => {
    expect(sourcesFor("https://arweave.net/abc/def.png")).toEqual(["https://arweave.net/abc/def.png"]);
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
    expect(calls).toEqual([ARDRIVE]);
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

  test("when one gateway fails, the other serves it (#15639's art on arweave.net)", async () => {
    const { fetchImpl, calls } = fakeFetch({ "ardrive.net": 572 });
    const res = await createThumbs({ cache: memoryCache(), fetchImpl })(SRC);
    expect(res.status).toBe(200);
    expect(calls).toEqual([ARDRIVE, SRC]);
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
