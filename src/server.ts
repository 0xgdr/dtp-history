import index from "../public/index.html";
import { S3Client } from "bun";
import { copyDirToBucket, fileCache, s3Cache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { createApi } from "./api.ts";
import { loadIndex } from "./index-lookup.ts";
import { createFetcher } from "./json-fetch.ts";
import { createRpc } from "./rpc.ts";
import { siteOrigin, withShareTags } from "./share.ts";

const config = loadConfig();
// S3Client reads S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_ENDPOINT from the environment.
const bucket = config.cacheBucket ? new S3Client({ bucket: config.cacheBucket }) : null;
const cache = bucket ? s3Cache(bucket, config.cachePrefix) : fileCache(config.cacheDir);
console.log(config.cacheBucket ? `Cache: bucket ${config.cacheBucket}/${config.cachePrefix}` : `Cache: ${config.cacheDir}`);
const pandaIndex = await loadIndex(`${import.meta.dir}/../data/panda-index.json`);
if (!pandaIndex) console.warn("data/panda-index.json not found: number lookups are off until `bun run index`");

const api = createApi({
  rpc: createRpc(config.rpcUrl, { rps: config.rpcRps, concurrency: config.rpcConcurrency }),
  fetcher: createFetcher(cache),
  cache,
  index: pandaIndex,
});

const production = Bun.env.NODE_ENV === "production";
const ogImage = Bun.file(`${import.meta.dir}/../public/og.png`);

// The bundled page, fetched once from its own route in production (every time in development,
// so hot reload still sees changes). "/" serves it with the share-card URLs filled in.
let pageHtml: string | null = null;
async function page(req: Request): Promise<Response> {
  if (!pageHtml || !production) pageHtml = await (await fetch(new URL("/_page", server.url))).text();
  const url = new URL(req.url);
  const html = await withShareTags(pageHtml, siteOrigin(req, config.publicUrl), url.pathname + url.search);
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// HTML import: Bun bundles the page's <script> and <link> tags itself, with hot reload under
// `bun --hot`.
const server = Bun.serve({
  port: config.port,
  idleTimeout: 120, // uncached histories can take 10–30 s
  routes: {
    "/": page,
    "/_page": index,
    "/og.png": () =>
      new Response(ogImage, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } }),
    "/healthz": new Response("ok"),
    "/api/panda/:n": { GET: (req) => api.panda(req.params.n) },
    "/api/mint/:mint": { GET: (req) => api.mint(req.params.mint) },
    "/api/random": { GET: () => api.random() },
    "/api/*": Response.json({ error: "not_found", detail: "unknown API route" }, { status: 404 }),
  },
  development: !production && { hmr: true, console: true },
});

console.log(`Listening on ${server.url}`);

// One-off move from a volume to R2 without a shell: set COPY_CACHE_FROM, deploy, wait for
// "Cache copy done" in the logs, then remove it. Runs alongside requests and skips entries already
// copied, so a restart part-way through just carries on.
if (config.copyCacheFrom) {
  const from = config.copyCacheFrom;
  if (!bucket) {
    console.warn("COPY_CACHE_FROM is set but S3_BUCKET is not: nothing to copy into");
  } else {
    console.log(`Cache copy: ${from} -> ${config.cacheBucket}/${config.cachePrefix}`);
    copyDirToBucket(from, bucket, config.cachePrefix, (line) => console.log(`Cache copy: ${line}`))
      .then((s) =>
        console.log(
          `Cache copy done: ${s.copied} copied, ${s.skipped} already there, ${s.failed} failed. Remove COPY_CACHE_FROM.`,
        ),
      )
      .catch((err) => console.error(`Cache copy failed: ${err instanceof Error ? err.message : err}`));
  }
}

// Railway sends SIGTERM when a new deploy replaces this one. Stop taking requests, let the ones
// in flight finish (up to 10 s), then exit cleanly instead of being killed mid-request.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: finishing in-flight requests, then exiting`);
    await Promise.race([server.stop(), Bun.sleep(10_000)]);
    process.exit(0);
  });
}
