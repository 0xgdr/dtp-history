import type { Cache } from "./cache.ts";
import { thumbSourceOk } from "./thumb-source.ts";

// Small WebP copies of Panda art for the grids and the timeline, made once and kept in the cache
// (R2 in production). The originals are PNGs of ~2 MB shown in tiles ~200 px wide. Only sources
// thumbSourceOk accepts (Arweave and ArDrive) are fetched.
const SIZE = 400; // twice the largest tile, for high-density screens
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 8192 * 8192;
const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable" };

export function createThumbs({ cache, fetchImpl = fetch }: { cache: Cache; fetchImpl?: typeof fetch }) {
  // Concurrent requests for one image share one fetch and encode.
  const inflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

  async function make(src: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetchImpl(src, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`source answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("source too large");
    const bytes = await res.bytes();
    if (bytes.length > MAX_BYTES) throw new Error("source too large");
    const webp = await new Bun.Image(bytes, { maxPixels: MAX_PIXELS })
      .resize(SIZE, SIZE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .blob();
    return new Uint8Array(await webp.arrayBuffer());
  }

  return async function thumb(src: string | null): Promise<Response> {
    if (!src || !thumbSourceOk(src)) {
      return Response.json({ error: "bad_input", detail: "src must be an https Arweave or ArDrive image" }, { status: 400 });
    }
    const key = new Bun.CryptoHasher("sha256").update(src).digest("hex");
    const cached = await cache.getBytes("thumb", key);
    if (cached) return new Response(cached, { headers: { "content-type": "image/webp", ...CACHE_HEADERS } });

    let pending = inflight.get(key);
    if (!pending) {
      pending = make(src).then(async (bytes) => {
        await cache.setBytes("thumb", key, bytes, "image/webp");
        return bytes;
      });
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => {});
    }
    try {
      return new Response(await pending, { headers: { "content-type": "image/webp", ...CACHE_HEADERS } });
    } catch (err) {
      console.warn(`thumb ${src}: ${err instanceof Error ? err.message : err}`);
      // Not cached: the source may be back later.
      return Response.json({ error: "thumb_failed", detail: "the image could not be fetched or read" }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  };
}
