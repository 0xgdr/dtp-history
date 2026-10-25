import { S3Client } from "bun";
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { copyDirToBucket } from "../scripts/copy-cache-to-r2.ts";
import { fileCache, s3Cache } from "../src/cache.ts";

// A minimal S3 stand-in: PUT stores the body, GET/HEAD return it or S3's NoSuchKey error.
const objects = new Map<string, string>();
let failing = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (failing) return new Response("boom", { status: 500 });
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (req.method === "PUT") {
      objects.set(path, await req.text());
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    const body = objects.get(path);
    if (req.method === "HEAD") return new Response(null, { status: body === undefined ? 404 : 200 });
    if (body !== undefined) return new Response(body, { headers: { "content-type": "application/json" } });
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`,
      { status: 404, headers: { "content-type": "application/xml" } },
    );
  },
});
afterAll(() => server.stop(true));

const client = new S3Client({
  accessKeyId: "test",
  secretAccessKey: "test",
  bucket: "bucket",
  endpoint: server.url.origin,
});

test("s3Cache round-trips JSON under the prefix and treats a missing key as a miss", async () => {
  const cache = s3Cache(client, "app/cache/");
  expect(await cache.get("tx", "sig1")).toBeNull();
  await cache.set("tx", "sig1", { slot: 1, logs: ["a"] });
  expect(await cache.get("tx", "sig1")).toEqual({ slot: 1, logs: ["a"] });
  expect([...objects.keys()]).toEqual(["/bucket/app/cache/tx/sig1.json"]);
});

test("s3Cache never throws when the bucket is down", async () => {
  const cache = s3Cache(client, "app/cache/");
  failing = true;
  try {
    expect(await cache.get("history", "mint")).toBeNull();
    await cache.set("history", "mint", { ok: true });
  } finally {
    failing = false;
  }
});

test("copyDirToBucket copies a file cache so s3Cache reads the same entries, skipping ones already there", async () => {
  const dir = `${import.meta.dir}/../.cache/copy-test-${process.pid}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const local = fileCache(dir);
    const longUrl = `https://arweave.net/${"x".repeat(200)}`;
    await local.set("tx", "sigA", { slot: 2 });
    await local.set("json", longUrl, { name: "Panda" });
    await local.set("history", "mintB", { version: 3 });
    await Bun.write(`${dir}/tx/sigB.json.123.456.tmp`, "half-written");

    const remote = s3Cache(client, "copy/");
    await remote.set("history", "mintB", { version: 3 });
    const lines: string[] = [];
    expect(await copyDirToBucket(dir, client, "copy/", (l) => lines.push(l))).toEqual({ copied: 2, skipped: 1, failed: 0 });

    expect(await remote.get("tx", "sigA")).toEqual({ slot: 2 });
    expect(await remote.get("json", longUrl)).toEqual({ name: "Panda" });
    expect(await remote.get("tx", "sigB")).toBeNull();
    expect(lines).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
