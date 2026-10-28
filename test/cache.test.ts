import { S3Client } from "bun";
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fileCache, s3Cache } from "../src/cache.ts";

// A minimal S3 stand-in: PUT stores the body and its type, GET returns them or S3's NoSuchKey error.
const objects = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
let failing = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (failing) return new Response("boom", { status: 500 });
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (req.method === "PUT") {
      objects.set(path, { body: await req.bytes(), type: req.headers.get("content-type") ?? "" });
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    const object = objects.get(path);
    if (object !== undefined) return new Response(object.body, { headers: { "content-type": object.type } });
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

test("s3Cache round-trips bytes with their content type, and a missing key is a miss", async () => {
  const cache = s3Cache(client, "app/cache/");
  expect(await cache.getBytes("thumb", "abc")).toBeNull();
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await cache.setBytes("thumb", "abc", bytes, "image/webp");
  expect(await cache.getBytes("thumb", "abc")).toEqual(bytes);
  expect(objects.get("/bucket/app/cache/thumb/abc")?.type).toBe("image/webp");
});

test("fileCache round-trips bytes", async () => {
  const dir = `${import.meta.dir}/../.cache/test-file-cache-${process.pid}`;
  try {
    const cache = fileCache(dir);
    expect(await cache.getBytes("thumb", "abc")).toBeNull();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await cache.setBytes("thumb", "abc", bytes, "image/webp");
    expect(await cache.getBytes("thumb", "abc")).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
