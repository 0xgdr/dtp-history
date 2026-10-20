import index from "../public/index.html";
import { loadConfig } from "./config.ts";

const config = loadConfig();

// HTML import: Bun bundles the page's <script> and <link> tags itself, with hot reload under
// `bun --hot`. API routes land in later PRs.
const server = Bun.serve({
  port: config.port,
  routes: {
    "/": index,
    "/healthz": new Response("ok"),
    "/api/*": Response.json({ error: "not_found", detail: "API not implemented yet" }, { status: 404 }),
  },
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`Listening on ${server.url}`);
