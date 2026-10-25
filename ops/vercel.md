# Deploying on Vercel

Vercel runs `src/server.ts` on its Bun runtime: it sees the `Bun.serve()` call and routes every
request to it as a Vercel Function. `vercel.json` picks Bun 1.4 and sets the build command.

## How it works

- **Build** (`bun run build`, on every deploy): `scripts/build-page.ts` bundles `web/index.html`
  with its script, styles and images, plus `og.png`, into `src/page.gen.js`. The server imports
  that module, so the page is deployed with the code. Vercel's Bun runtime doesn't support Bun's
  HTML imports in `routes`, which is what `bun run dev` uses.
- **Panda index:** `data/panda-index.json` is imported by the server, so it ships the same way.
- **Cache:** R2, as on Railway (`S3_BUCKET` and friends). Nothing is written to Vercel's disk.
- **Background work:** a history that takes longer than 15 s is answered with "still building"
  (202) and keeps building, and cached Pandas are re-checked after they're served. On Vercel the
  server hands that work to `waitUntil` (from `@vercel/functions`), so it isn't cut off when the
  response is sent.
- **More than one instance:** Vercel may run several copies of the server. Each has its own list
  of builds in progress and its own RPC rate limit. A progress poll that lands on another copy
  starts its own build: more Helius calls and a progress bar that jumps, but the same answer. At
  this site's traffic Vercel usually reuses one instance.

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
