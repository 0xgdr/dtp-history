# Deploying on Railway

Railway builds the repo with Railpack (no Dockerfile), using the Bun version pinned in
`package.json`. `railway.json` sets the start command (`bun run start`), the health check
(`/healthz`) and restart-on-failure, so those don't need setting in the dashboard.

## 1. Service

**+ New → GitHub repo → `0xgdr/dtp-history`.** Railway deploys `main` on every push.

## 2. Cache: R2

The cache lives in a Cloudflare R2 bucket, so it survives deploys without a Railway volume and
the service holds nothing on disk. Without it, every deploy starts cold and the first lookup of
each Panda goes back to the RPC. Transactions and JSON never change, so the cache only grows;
expect a few KB per Panda (about 50 MB if all ~17.5k are looked up), well inside R2's free tier.

In Cloudflare: **R2 → Manage API tokens → Create API token**, *Object Read & Write*, limited to
the bucket. An existing bucket is fine: entries go under `CACHE_PREFIX` (default
`dtp-history/cache/`).

### Copying an old volume cache into R2

A service that used a volume at `/data` can copy that cache across before the volume is removed.
With the Railway CLI linked to the project:

```
railway ssh -- bun scripts/copy-cache-to-r2.ts /data/cache
```

It skips entries already in the bucket, so it can be run again if interrupted.

## 3. Variables

| Variable | Value |
|---|---|
| `RPC_URL` | Your Helius endpoint, including `?api-key=`. Secret. |
| `S3_BUCKET` | The R2 bucket name. Setting it turns the R2 cache on. |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` | From the R2 API token. Secret. |
| `S3_SECRET_ACCESS_KEY` | From the R2 API token. Secret. |
| `RPC_RPS` | A bit under your Helius plan's RPC requests-per-second limit (see your Helius dashboard). |
| `RPC_CONCURRENCY` | `4` on the free plan; `10` or more on paid plans. |

`PORT` is set by Railway. Nothing else is needed.

## 4. First deploy

- Logs: `Cache: bucket <name>/dtp-history/cache/` and `Listening on http://…`. A warning about
  `data/panda-index.json` means the index wasn't committed: run `bun run index` locally and commit the file.
- **Settings → Networking → Generate Domain**, then:
  - `curl https://<domain>/healthz` → `ok`
  - `https://<domain>/?n=6872`: the first load builds the history (a few seconds on Helius),
    and later loads come straight from the cache.

## How it stays fast

- **Index:** `data/panda-index.json` is committed, so number lookups need no RPC call.
- **Cache:** past transactions and JSON are cached forever in R2. A failed R2 read or write is
  logged and treated as a miss, so an R2 outage slows lookups but never breaks them.
- **Stale-while-revalidate:** a cached Panda is answered immediately. At most once a minute per
  Panda, a background check looks for new transactions, and the next request sees the result.
- **Cold lookups:** about 55 `getTransaction` calls per Panda, limited by `RPC_RPS` and
  `RPC_CONCURRENCY`.

## Moving off Railway

Nothing here is Railway-specific beyond `railway.json`: any host that runs a long-lived
`bun run start` with the variables above works, with no disk needed (Fly.io, Render, a VPS).
