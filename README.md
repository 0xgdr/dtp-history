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

| Var | Default | Notes |
|---|---|---|
| `RPC_URL` | public mainnet RPC | Full endpoint including any provider key (e.g. Helius `?api-key=`). Secret: never logged, only its host. |
| `RPC_RPS` | `8` | Token-bucket rate limit for RPC calls. |
| `CACHE_DIR` | `.cache` | File cache (gitignored). |
| `PORT` | `3000` | |

## Scripts

```sh
bun run dev        # server with hot reload (Bun HTML imports bundle public/)
bun run start      # production mode
bun test           # offline unit tests on test/fixtures
bun run typecheck
bun run fixtures   # re-record test/fixtures/6872 (needs RPC_URL)
```

The page is a plain `public/index.html` imported by `src/server.ts` and passed to
`Bun.serve({ routes })`. Bun bundles its `<script>` and `<link>` tags on request; no separate
build step.

## Fixtures

`test/fixtures/6872/` holds the raw `getTransaction` results for every tx that has a Token
Metadata instruction on Panda #6872's metadata account, one noise tx, the JSON of each URI and
the current account. They are public chain data, committed, and not regenerated in CI. The
recording script never writes the RPC URL into any file.
