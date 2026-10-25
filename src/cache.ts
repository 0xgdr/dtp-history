import type { S3Client } from "bun";
import { mkdir, rename } from "node:fs/promises";

export type Namespace = "tx" | "json" | "imghash" | "history";

export type Cache = {
  get<T>(ns: Namespace, key: string): Promise<T | null>;
  set(ns: Namespace, key: string, value: unknown): Promise<void>;
};

// One JSON file per entry under `<dir>/<namespace>/`. Writes go to a temp file and are renamed
// into place, so a crash never leaves a half-written entry behind.
export function fileCache(dir: string): Cache {
  const pathFor = (ns: Namespace, key: string) => `${dir}/${ns}/${safeKey(key)}.json`;
  return {
    async get<T>(ns: Namespace, key: string): Promise<T | null> {
      const file = Bun.file(pathFor(ns, key));
      if (!(await file.exists())) return null;
      try {
        return (await file.json()) as T;
      } catch {
        return null;
      }
    },
    async set(ns, key, value) {
      await mkdir(`${dir}/${ns}`, { recursive: true });
      const path = pathFor(ns, key);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await Bun.write(tmp, JSON.stringify(value));
      await rename(tmp, path);
    },
  };
}

type Bucket = Pick<S3Client, "file">;

// One JSON object per entry at `<prefix><namespace>/<key>.json` in an S3-compatible bucket
// (Cloudflare R2 in production), so the cache outlives deploys without a volume. A failed read
// counts as a miss and a failed write is only logged: the cache saves RPC calls, it is never
// needed for a correct answer.
export function s3Cache(bucket: Bucket, prefix = ""): Cache {
  const keyFor = (ns: Namespace, key: string) => `${prefix}${ns}/${safeKey(key)}.json`;
  return {
    async get<T>(ns: Namespace, key: string): Promise<T | null> {
      try {
        return (await bucket.file(keyFor(ns, key)).json()) as T;
      } catch (err) {
        if ((err as { code?: string }).code !== "NoSuchKey") console.warn(`cache read ${ns}/${key}: ${errMessage(err)}`);
        return null;
      }
    },
    async set(ns, key, value) {
      try {
        await bucket.file(keyFor(ns, key)).write(JSON.stringify(value), { type: "application/json" });
      } catch (err) {
        console.warn(`cache write ${ns}/${key}: ${errMessage(err)}`);
      }
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const COPY_CONCURRENCY = 16;

export type CopyStats = { copied: number; skipped: number; failed: number };

// Copies a file cache into a bucket for s3Cache. Both use `<namespace>/<key>.json`, so files go
// across as they are; entries already in the bucket are skipped.
export async function copyDirToBucket(
  dir: string,
  bucket: Bucket,
  prefix: string,
  log: (line: string) => void = console.log,
): Promise<CopyStats> {
  const stats: CopyStats = { copied: 0, skipped: 0, failed: 0 };
  // Only finished entries: in-progress writes are `<key>.json.<pid>.<time>.tmp`.
  const files = new Bun.Glob("*/*.json").scan({ cwd: dir });

  const worker = async () => {
    for await (const rel of files) {
      const target = bucket.file(`${prefix}${rel}`);
      try {
        if (await target.exists()) {
          stats.skipped++;
        } else {
          await target.write(Bun.file(`${dir}/${rel}`), { type: "application/json" });
          stats.copied++;
        }
      } catch (err) {
        stats.failed++;
        log(`failed ${rel}: ${err instanceof Error ? err.message : err}`);
      }
      const done = stats.copied + stats.skipped + stats.failed;
      if (done % 500 === 0) log(`${done} done (${stats.copied} copied, ${stats.skipped} skipped)`);
    }
  };
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
  return stats;
}

export function memoryCache(): Cache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(ns: Namespace, key: string) {
      return (store.get(`${ns}/${key}`) as T | undefined) ?? null;
    },
    async set(ns, key, value) {
      store.set(`${ns}/${key}`, structuredClone(value));
    },
  };
}

// File-name safe and reversible for short keys; long keys (arbitrary URLs) are hashed.
function safeKey(key: string): string {
  if (key.length > 120) return `h-${new Bun.CryptoHasher("sha256").update(key).digest("hex")}`;
  return key.replace(/[^A-Za-z0-9_.-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
