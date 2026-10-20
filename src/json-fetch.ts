import type { Cache } from "./cache.ts";
import { gatewayUrls, normalizeUri } from "./uri.ts";

const TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type JsonResult = { json: Record<string, unknown> | null; error: string | null };

export type Fetcher = {
  json(uri: string): Promise<JsonResult>;
  // SHA-256 of the image bytes, or null if every gateway failed.
  imageHash(uri: string): Promise<string | null>;
};

// Fetches metadata JSON and image hashes by canonical key. Successful results are cached
// forever: Arweave content is immutable. Failures are not cached, so a later request retries.
export function createFetcher(cache: Cache, fetchImpl: typeof fetch = fetch): Fetcher {
  const inflight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  return {
    json(uri) {
      const { key } = normalizeUri(uri);
      return once(`json:${key}`, async () => {
        const cached = await cache.get<Record<string, unknown>>("json", key);
        if (cached) return { json: cached, error: null };
        try {
          const bytes = await fetchFirst(fetchImpl, gatewayUrls(uri), MAX_JSON_BYTES);
          const json = JSON.parse(new TextDecoder().decode(bytes));
          if (json === null || typeof json !== "object" || Array.isArray(json)) {
            return { json: null, error: "metadata is not a JSON object" };
          }
          await cache.set("json", key, json);
          return { json, error: null };
        } catch (err) {
          return { json: null, error: err instanceof Error ? err.message : String(err) };
        }
      });
    },

    imageHash(uri) {
      const { key } = normalizeUri(uri);
      return once(`img:${key}`, async () => {
        const cached = await cache.get<string>("imghash", key);
        if (cached) return cached;
        try {
          const bytes = await fetchFirst(fetchImpl, gatewayUrls(uri), MAX_IMAGE_BYTES);
          const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
          await cache.set("imghash", key, hash);
          return hash;
        } catch {
          return null;
        }
      });
    },
  };
}

// Tries each URL in order, two attempts each. Throws the last error if all fail.
async function fetchFirst(fetchImpl: typeof fetch, urls: string[], maxBytes: number): Promise<Uint8Array> {
  let lastError: unknown = new Error("no URL to fetch");
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${hostOf(url)}`);
        return await readCapped(res, maxBytes);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Bun.concatArrayBuffers(chunks, Infinity, true);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid URL";
  }
}
