import index from "../public/index.html";
import { fileCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { createApi } from "./api.ts";
import { loadIndex } from "./index-lookup.ts";
import { createFetcher } from "./json-fetch.ts";
import { createRpc } from "./rpc.ts";

const config = loadConfig();
const cache = fileCache(config.cacheDir);
const pandaIndex = await loadIndex(`${import.meta.dir}/../data/panda-index.json`);
if (!pandaIndex) console.warn("data/panda-index.json not found: number lookups are off until `bun run index`");

const api = createApi({
  rpc: createRpc(config.rpcUrl, { rps: config.rpcRps, concurrency: config.rpcConcurrency }),
  fetcher: createFetcher(cache),
  cache,
  index: pandaIndex,
});

// HTML import: Bun bundles the page's <script> and <link> tags itself, with hot reload under
// `bun --hot`.
const server = Bun.serve({
  port: config.port,
  idleTimeout: 120, // uncached histories can take 10–30 s
  routes: {
    "/": index,
    "/healthz": new Response("ok"),
    "/api/panda/:n": { GET: (req) => api.panda(req.params.n) },
    "/api/mint/:mint": { GET: (req) => api.mint(req.params.mint) },
    "/api/*": Response.json({ error: "not_found", detail: "unknown API route" }, { status: 404 }),
  },
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`Listening on ${server.url}`);
