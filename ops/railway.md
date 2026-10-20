# Deploying on Railway

Railway builds the repo with Railpack (no Dockerfile), using the Bun version pinned in
`package.json`. `railway.json` sets the start command (`bun run start`), the health check
(`/healthz`) and restart-on-failure, so those don't need setting in the dashboard.

## 1. Service

**+ New → GitHub repo → `0xgdr/dtp-history`.** Railway deploys `main` on every push.
Replicas: 1 (a volume can't be shared).

## 2. Volume

**+ New → Volume**, attached to the service, mounted at `/data`.

The cache lives here. Without it, every deploy starts cold and the first lookup of each Panda
goes back to the RPC. Transactions and JSON never change, so the cache only grows; expect a few
KB per Panda (about 50 MB if all ~17.5k are looked up).

If the logs show `EACCES` on `/data`, set `RAILWAY_RUN_UID=0` (Railway's documented fix).

## 3. Variables

| Variable | Value |
|---|---|
| `RPC_URL` | Your Helius endpoint, including `?api-key=`. Secret. |
| `CACHE_DIR` | `/data/cache` |
| `RPC_RPS` | A bit under your Helius plan's RPC requests-per-second limit (see your Helius dashboard). |
| `RPC_CONCURRENCY` | `4` on the free plan; `10` or more on paid plans. |

`PORT` is set by Railway. Nothing else is needed.

## 4. First deploy

- Logs: `Listening on http://…`. A warning about `data/panda-index.json` means the index wasn't
  committed: run `bun run index` locally and commit the file.
- **Settings → Networking → Generate Domain**, then:
  - `curl https://<domain>/healthz` → `ok`
  - `https://<domain>/?n=6872`: the first load builds the history (a few seconds on Helius),
    and later loads come straight from the cache.

## How it stays fast

- **Index:** `data/panda-index.json` is committed, so number lookups need no RPC call.
- **Cache:** past transactions and JSON are cached forever on the volume.
- **Stale-while-revalidate:** a cached Panda is answered immediately. At most once a minute per
  Panda, a background check looks for new transactions, and the next request sees the result.
- **Cold lookups:** about 55 `getTransaction` calls per Panda, limited by `RPC_RPS` and
  `RPC_CONCURRENCY`.
