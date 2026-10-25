# Deploying on Vercel

Vercel runs `src/server.ts` on its Bun runtime: it sees the `Bun.serve()` call and routes every
request to it as a Vercel Function. `vercel.json` picks Bun 1.4 and sets the build command.

## How it works

- **Build** (`bun run build`, on every deploy): `scripts/build-page.ts` bundles `web/index.html`
  with its script, styles and images, plus `og.png`, into `src/page.gen.js`. The server imports
  that module, so the page is deployed with the code. Vercel's Bun runtime doesn't support Bun's
  HTML imports in `routes`, which is what `bun run dev` uses.
- **Server bundle:** the build then bundles `src/site.ts` (the app) with every package it imports
  into `src/site.gen.js`, and on Vercel `src/server.ts` runs that instead of `src/site.ts`. Vercel's
  Bun runtime ships `src/` but didn't ship `node_modules`, so requests failed with
  `Cannot find package '@solana/kit'`. Elsewhere `src/server.ts` runs `src/site.ts` directly.
  Don't name a file `app` or `index` in the root or `src/`: Vercel picks its entrypoint from
  `app`, `index` or `server` there, and chose `src/app.ts` over `src/server.ts`.
- **Panda index:** `data/panda-index.json` is imported by the server, so it ships the same way.
- **Cache:** R2, as on Railway (`S3_BUCKET` and friends). Nothing is written to Vercel's disk.
- **Background work:** a history that takes longer than 15 s is answered with "still building"
  (202) and keeps building, and cached Pandas are re-checked after they're served. On Vercel the
  server hands that work to `waitUntil` (from `@vercel/functions`), so it isn't cut off when the
  response is sent.
- **More than one instance:** Vercel may run several copies of the server. While a new history
  is building, the copy doing it keeps a small "building" marker in R2 with its progress,
  rewritten every 5 s. A progress poll that lands on another copy reports that progress instead
  of starting a second build. If the building copy stops (crashed or frozen), the marker goes
  stale after 20 s and the next poll starts the build again; a failed build marks itself stale
  at once. Each copy still has its own RPC rate limit, so together they can exceed `RPC_RPS`;
  the RPC client backs off on 429s, so that slows lookups rather than failing them.

## First deploy

1. **Add New → Project → Import** `0xgdr/dtp-history`. Framework preset: leave what Vercel
   detects (Bun, from `vercel.json` and `src/server.ts`). Build command comes from `vercel.json`.
2. **Environment variables** (Production), before the first deploy:

   | Variable | Value |
   |---|---|
   | `RPC_URL` | Helius endpoint including `?api-key=`. Sensitive. |
   | `RPC_RPS` | A bit under your Helius plan's limit, e.g. `8` on free. |
   | `RPC_CONCURRENCY` | `4` on free, `10`+ on paid. |
   | `S3_BUCKET` | `dtp-history-cache` |
   | `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `S3_ACCESS_KEY_ID` | R2 API token (Object Read & Write, this bucket only). Sensitive. |
   | `S3_SECRET_ACCESS_KEY` | Same token. Sensitive. |

3. **Deploy.** Vercel deploys `main` on every push, and other branches as previews.

## Check it

- `https://<project>.vercel.app/healthz` → `ok`
- Look up a Panda twice: the second load is instant, and files appear under
  `dtp-history/cache/` in the bucket.
- Logs (Project → Logs) show `Cache: bucket dtp-history-cache/dtp-history/cache/`.

## Custom domain

Project → Settings → Domains → Add. Share-card URLs come from the request's host; set
`PUBLIC_URL` only if they show the wrong address.

## Retiring Railway

Once the Vercel deploy works: delete the Railway service and its volume, then delete
`railway.json` and `ops/railway.md` from the repo.
