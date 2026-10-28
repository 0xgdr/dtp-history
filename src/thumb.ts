import type { Cache } from "./cache.ts";
import { thumbSourceOk } from "./thumb-source.ts";

// Small WebP copies of Panda art for the grids and the timeline, made once and kept in the cache
// (R2 in production). The originals are PNGs of ~2 MB shown in tiles ~200 px wide. Only sources
// thumbSourceOk accepts (Arweave and ArDrive) are fetched.
const SIZE = 400; // twice the largest tile, for high-density screens
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 8192 * 8192;
const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable" };
const ATTEMPT_MS = 20_000;

export type ThumbFormat = "webp" | "jpeg";

// Where to fetch an image from, in order. Arweave addresses are content hashes that any Arweave
// gateway serves, and arweave.net can fail on a file ArDrive serves in seconds (#15639's art: 572
// after 50 s, against 200 in 3 s), so for either host try the other too, ArDrive first.
export function sourcesFor(src: string): string[] {
  const url = new URL(src);
  const id = /^\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];
  if (!id) return [src];
  const ardrive = `https://ardrive.net/${id}`;
  const arweave = `https://arweave.net/${id}`;
  return url.host === "ardrive.net" ? [src, arweave] : [ardrive, src];
}

export function createThumbs({ cache, fetchImpl = fetch }: { cache: Cache; fetchImpl?: typeof fetch }) {
  // Concurrent requests for one image share one fetch and encode.
  const inflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

  async function download(url: string): Promise<Uint8Array> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEMPT_MS) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("source too large");
    const bytes = await res.bytes();
    if (bytes.length > MAX_BYTES) throw new Error("source too large");
    return bytes;
  }

  async function make(src: string, format: ThumbFormat): Promise<Uint8Array<ArrayBuffer>> {
    const failures: string[] = [];
    let bytes: Uint8Array | null = null;
    for (const url of sourcesFor(src)) {
      try {
        bytes = await download(url);
        break;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (!bytes) throw new Error(failures.join("; "));
    const resized = new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).resize(SIZE, SIZE, { fit: "inside", withoutEnlargement: true });
    const out = await (format === "jpeg" ? resized.jpeg({ quality: 85 }) : resized.webp({ quality: 80 })).blob();
    return new Uint8Array(await out.arrayBuffer());
  }

  // WebP for the page's tiles; JPEG for share cards, since some crawlers (Facebook's, LinkedIn's)
  // only take JPEG, PNG or GIF.
  return async function thumb(src: string | null, format: ThumbFormat = "webp"): Promise<Response> {
    if (!src || !thumbSourceOk(src)) {
      return Response.json({ error: "bad_input", detail: "src must be an https Arweave or ArDrive image" }, { status: 400 });
    }
    const hash = new Bun.CryptoHasher("sha256").update(src).digest("hex");
    const key = format === "jpeg" ? `${hash}-jpeg` : hash;
    const type = `image/${format}`;
    const cached = await cache.getBytes("thumb", key);
    if (cached) return new Response(cached, { headers: { "content-type": type, ...CACHE_HEADERS } });

    let pending = inflight.get(key);
    if (!pending) {
      pending = make(src, format).then(async (bytes) => {
        await cache.setBytes("thumb", key, bytes, type);
        return bytes;
      });
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => {});
    }
    try {
      return new Response(await pending, { headers: { "content-type": type, ...CACHE_HEADERS } });
    } catch (err) {
      console.warn(`thumb ${src}: ${err instanceof Error ? err.message : err}`);
      // Not cached: the source may be back later.
      return Response.json({ error: "thumb_failed", detail: "the image could not be fetched or read" }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  };
}
