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
