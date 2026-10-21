import { buildHistory, readCachedHistory, type BuildProgress, type Deps, type HistoryResult } from "./history.ts";
import { parseInput, resolve, type PandaIndex } from "./index-lookup.ts";
import { RpcError } from "./rpc.ts";

type ApiDeps = Deps & {
  index: PandaIndex | null;
  // How often a cached history is re-checked against chain in the background.
  revalidateMs?: number;
  // How long a request waits for a new build before answering "still building" (202) instead.
  // The first request waits longer; follow-up polls answer quickly.
  firstWaitMs?: number;
  pollWaitMs?: number;
};

const FAILURE_TTL_MS = 60_000;

// Route handlers, kept apart from Bun.serve so tests can call them directly.
export function createApi(deps: ApiDeps) {
  let numbers: number[] | undefined;

  // Concurrent requests for the same mint share one build. Builds report progress, and a build
  // that fails is remembered briefly so the next poll reports it instead of quietly starting over.
  const inflight = new Map<string, Promise<HistoryResult>>();
  const progress = new Map<string, BuildProgress>();
  const failures = new Map<string, { err: unknown; at: number }>();
  const history = (mint: string): Promise<HistoryResult> => {
    let p = inflight.get(mint);
    if (!p) {
      p = buildHistory(mint, { ...deps, onProgress: (pr) => progress.set(mint, pr) })
        .catch((err) => {
          failures.set(mint, { err, at: Date.now() });
          throw err;
        })
        .finally(() => {
          inflight.delete(mint);
          progress.delete(mint);
        });
      p.catch(() => {}); // a poll may have stopped waiting; the failure is kept above
      inflight.set(mint, p);
    }
    return p;
  };

  // Stale-while-revalidate: a cached history is returned at once, and at most once per
  // `revalidateMs` a background build picks up any new signatures for the next request.
  const revalidateMs = deps.revalidateMs ?? 60_000;
  const lastChecked = new Map<string, number>();
  const cachedOrBuild = async (mint: string): Promise<HistoryResult | "building"> => {
    const cached = await readCachedHistory(mint, deps.cache);
    if (!cached) {
      const failed = failures.get(mint);
      if (failed) {
        failures.delete(mint);
        if (Date.now() - failed.at < FAILURE_TTL_MS) throw failed.err;
      }
      const wait = inflight.has(mint) ? (deps.pollWaitMs ?? 1500) : (deps.firstWaitMs ?? 15_000);
      return Promise.race([history(mint), Bun.sleep(wait).then(() => "building" as const)]);
    }
    const now = Date.now();
    if (now - (lastChecked.get(mint) ?? 0) >= revalidateMs) {
      lastChecked.set(mint, now);
      history(mint).catch((err) => console.error("revalidate failed:", err instanceof Error ? err.message : err));
    }
    return cached;
  };

  async function respond(mint: string, number: number | null): Promise<Response> {
    try {
      const result = await cachedOrBuild(mint);
      if (result === "building") {
        // Long history: answer now with how far the build has got; the page polls again.
        return Response.json(
          { status: "building", ...(progress.get(mint) ?? { phase: "signatures", done: 0, total: null }) },
          { status: 202, headers: { "cache-control": "no-store", "retry-after": "2" } },
        );
      }
      return Response.json(number !== null ? { ...result, number } : result);
    } catch (err) {
      if (err instanceof RpcError) return error(502, "rpc_failed", "the Solana RPC failed after retries");
      console.error("history failed:", err instanceof Error ? err.message : err);
      return error(500, "internal", "failed to build the history");
    }
  }

  return {
    async panda(raw: string): Promise<Response> {
      const input = parseInput(safeDecode(raw));
      if (input.type === "mint") return respond(input.mint, null);
      if (input.type !== "number") return error(400, "bad_input", "enter a Panda number or a mint address");
      if (!deps.index) return error(503, "no_index", "the Panda index has not been built (bun run index)");

      const found = resolve(deps.index, input.n);
      switch (found.kind) {
        case "found":
        case "burned":
          return respond(found.mint, input.n);
        case "duplicate":
          return Response.json(
            { error: "duplicate", detail: `#${input.n} appears on more than one mint`, candidates: found.candidates },
            { status: 409 },
          );
        case "missing":
          return error(404, "missing", `#${input.n} has no mint in the collection`);
        case "unknown":
          return error(404, "not_found", `#${input.n} is not in the index`);
      }
    },

    async mint(raw: string): Promise<Response> {
      const input = parseInput(safeDecode(raw));
      if (input.type !== "mint") return error(400, "bad_input", "not a base58 mint address");
      return respond(input.mint, null);
    },

    // A random Panda number from the index, so the page never lands on a missing number.
    random(pick: () => number = Math.random): Response {
      if (!deps.index) return error(503, "no_index", "the Panda index has not been built (bun run index)");
      numbers ??= Object.keys(deps.index.pandas).map(Number);
      const n = numbers[Math.floor(pick() * numbers.length)];
      if (n === undefined) return error(404, "not_found", "the index is empty");
      return Response.json({ number: n }, { headers: { "cache-control": "no-store" } });
    },
  };
}

function error(status: number, code: string, detail: string): Response {
  return Response.json({ error: code, detail }, { status });
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
