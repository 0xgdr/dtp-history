import { S3Client } from "bun";
import pandaIndexJson from "../data/panda-index.json" with { type: "json" };
import { fileCache, s3Cache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { createApi } from "./api.ts";
import type { PandaIndex } from "./index-lookup.ts";
import { createFetcher } from "./json-fetch.ts";
import { createRpc } from "./rpc.ts";
import { siteOrigin, withShareTags } from "./share.ts";

const config = loadConfig();
// Vercel sets VERCEL=1. It runs this file as a function: the page comes from the build, and work
// that outlives a response has to be handed to waitUntil or it may be cut off.
const onVercel = Boolean(Bun.env.VERCEL);
const production = Bun.env.NODE_ENV === "production" || onVercel;

// S3Client reads S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_ENDPOINT from the environment.
const cache = config.cacheBucket
  ? s3Cache(new S3Client({ bucket: config.cacheBucket }), config.cachePrefix)
  : fileCache(config.cacheDir);
console.log(config.cacheBucket ? `Cache: bucket ${config.cacheBucket}/${config.cachePrefix}` : `Cache: ${config.cacheDir}`);

const api = createApi({
  rpc: createRpc(config.rpcUrl, { rps: config.rpcRps, concurrency: config.rpcConcurrency }),
  fetcher: createFetcher(cache),
  cache,
  index: pandaIndexJson as PandaIndex,
  background: onVercel ? (await import("@vercel/functions")).waitUntil : undefined,
});

// The page. Production serves what scripts/build-page.ts bundled into src/page.gen.js, so it
// ships with the code. Development uses Bun's HTML import instead, which bundles on request and hot
// reloads under `bun --hot`; "/" fetches it from its own route each time.
type Routes = Record<string, Response | ((req: Request) => Response | Promise<Response>)>;
let pageRoutes: Routes;
let pageHtml: () => Promise<string>;
if (production) {
  // Vercel runs `bun run build` before deploying; anywhere else, build now so it's never stale.
  if (!onVercel) await import("../scripts/build-page.ts");
  const page = await import("./page.gen.js").catch(() => {
    throw new Error("src/page.gen.js is missing: run `bun run build` first");
  });
  pageRoutes = {};
  for (const [path, asset] of Object.entries(page.assets)) {
    // Bundled assets have content hashes in their names, so they never change; og.png might.
    const maxAge = path === "/og.png" ? 86400 : 31536000;
    pageRoutes[path] = new Response(Buffer.from(asset.base64, "base64"), {
      headers: { "content-type": asset.type, "cache-control": `public, max-age=${maxAge}` },
    });
  }
  pageHtml = async () => page.html;
} else {
  const index = (await import("../web/index.html")).default;
  const og = Bun.file(`${import.meta.dir}/../web/og.png`);
  pageRoutes = { "/_page": index as unknown as Response, "/og.png": () => new Response(og) };
  pageHtml = async () => (await fetch(new URL("/_page", server.url))).text();
}

// "/" serves the page with the share-card URLs filled in.
async function page(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const html = await withShareTags(await pageHtml(), siteOrigin(req, config.publicUrl), url.pathname + url.search);
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 120, // uncached histories can take 10–30 s
  routes: {
    ...pageRoutes,
    "/": page,
    "/healthz": new Response("ok"),
    "/api/panda/:n": { GET: (req) => api.panda(req.params.n) },
    "/api/mint/:mint": { GET: (req) => api.mint(req.params.mint) },
    "/api/random": { GET: () => api.random() },
    "/api/*": Response.json({ error: "not_found", detail: "unknown API route" }, { status: 404 }),
  },
  development: !production && { hmr: true, console: true },
});

console.log(`Listening on ${server.url}`);

// The host sends SIGTERM when a new deploy replaces this one. Stop taking requests, let the ones
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
