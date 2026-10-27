# dtp-history

Read-only history and verdict tool for Degenerate Trash Pandas (Solana NFTs). Enter a Panda
number and it rebuilds that Panda's metadata history from chain and says whether its image or
traits have changed since mint. No wallets, no signing, no write calls.

Spec: `specs/dtp/2026-10-20-panda-history-app.md` in `0xgdr/grokbot-hub`.

## Setup

```sh
bun install
cp .env.example .env   # then set RPC_URL
```

`.env` can also be a 1Password Environment mount. Bun's automatic `.env` loading skips that
named pipe, so the `dev`, `index` and `fixtures` scripts pass `--env-file=.env` explicitly.

| Var | Default | Notes |
|---|---|---|
| `RPC_URL` | public mainnet RPC | Full endpoint including any provider key (e.g. Helius `?api-key=`). Secret: never logged, only its host. |
| `RPC_RPS` | `8` | Token-bucket rate limit for RPC calls. |
| `RPC_CONCURRENCY` | `4` | RPC calls in flight at once. |
| `CACHE_DIR` | `.cache` | File cache (gitignored). |
| `PORT` | `3000` | |
| `PUBLIC_URL` | request's host | Site origin used in share-card URLs. Only needed if the host can't be read from the request. |

## Scripts

```sh
bun run dev        # server with hot reload (Bun HTML imports bundle web/)
bun run start      # production mode (bundles the page first)
bun run build      # bundle the page and the server into src/*.gen.js (Vercel's build step)
bun test           # offline unit tests on test/fixtures
bun run typecheck
bun run index      # rebuild data/panda-index.json (needs a DAS-capable RPC_URL, e.g. Helius)
bun run fixtures   # re-record test/fixtures/6872 (needs RPC_URL)
```

The page is a plain `web/index.html`. In development `src/site.ts` imports it and passes it to
`Bun.serve({ routes })`, and Bun bundles its `<script>` and `<link>` tags on request with hot
reload. In production `scripts/build-page.ts` bundles it once into `src/page.gen.js`
(gitignored), which the server imports, so the page ships with the code on any host. On Vercel the
server also runs from a bundle, `src/site.gen.js`, with its packages inlined (see `ops/vercel.md`).

## API

| Route | |
|---|---|
| `GET /api/panda/:n` | Panda number (`6872`, `#6872`, `006872`) or a mint. Needs `data/panda-index.json`. |
| `GET /api/mint/:mint` | Any mint. Warns when it is not a verified DTP. |
| `GET /healthz` | `ok` |
| `GET /og.png` | Share card (1200×630) |

Errors are JSON `{error, detail}`: 400 bad input, 404 not in the index or missing, 409 duplicate
number (with `candidates`), 502 RPC failed after retries, 503 index not built.

The first uncached history takes a while: about a minute on the public RPC (it rate-limits
`getTransaction` hard), a few seconds with Helius. After that, a Panda is served from the cache
at once and re-checked against chain in the background, at most once a minute.

## Known data gaps

Some history can't be fully recovered, e.g. metadata moved to GenesysGo Shadow Drive in January
2023 that now returns 404. See `docs/data-gaps.md`.

## Deploy

Vercel: see `ops/vercel.md`, which also covers other hosts.

## Fixtures

`test/fixtures/6872/` holds the raw `getTransaction` results for every tx that has a Token
Metadata instruction on Panda #6872's metadata account, one noise tx, the JSON of each URI and
the current account. They are public chain data, committed, and not regenerated in CI. The
recording script never writes the RPC URL into any file.
