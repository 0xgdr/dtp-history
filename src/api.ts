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
  // Keeps a build running after the response that started it has been sent. Serverless hosts
  // (Vercel's waitUntil) may otherwise freeze or stop it; on a normal server it isn't needed.
  background?: (work: Promise<unknown>) => void;
  // See BuildMarker. Defaults: rewritten every 5 s, abandoned after 20 s without a rewrite.
  heartbeatMs?: number;
  markerStaleMs?: number;
};

const FAILURE_TTL_MS = 60_000;

// Written to the cache (R2 in production, shared by every copy of this server) while a new
// history is being built. A host like Vercel can run several copies, and a progress poll may land
// on one that isn't running the build: it reports the marker's progress instead of starting a
// second build. The copy building rewrites the marker every heartbeatMs; if it stops (crashed or
// frozen), the marker goes stale and the next poll starts the build again.
type BuildMarker = { at: number; progress: BuildProgress | null };
type Building = { building: BuildProgress | null };

export type Stats = { numbers: number; live: number; burned: number; missing: number[]; generatedAt: string };

// Route handlers, kept apart from Bun.serve so tests can call them directly.
export function createApi(deps: ApiDeps) {
  let numbers: number[] | undefined;

  // Concurrent requests for the same mint share one build. Builds report progress, and a build
  // that fails is remembered briefly so the next poll reports it instead of quietly starting over.
  const inflight = new Map<string, Promise<HistoryResult>>();
  const progress = new Map<string, BuildProgress>();
  const failures = new Map<string, { err: unknown; at: number }>();
  const heartbeatMs = deps.heartbeatMs ?? 5_000;
  const markerStaleMs = deps.markerStaleMs ?? 20_000;

  // Only new histories get a marker: a revalidate runs while the cached history is being served,
  // so no poll waits on it.
  const startMarker = (mint: string) => {
    const write = (at: number) =>
      deps.cache
        .set("building", mint, { at, progress: progress.get(mint) ?? null } satisfies BuildMarker)
        .catch(() => {});
    void write(Date.now());
    const timer = setInterval(() => void write(Date.now()), heartbeatMs);
    return {
      done: () => clearInterval(timer),
      // A failed build leaves a stale marker, so a poll on another copy retries straight away.
      failed: () => {
        clearInterval(timer);
        void write(0);
      },
    };
  };

  const history = (mint: string, isNew = false): Promise<HistoryResult> => {
    let p = inflight.get(mint);
    if (!p) {
      const marker = isNew ? startMarker(mint) : null;
      p = buildHistory(mint, { ...deps, onProgress: (pr) => progress.set(mint, pr) })
        .catch((err) => {
          failures.set(mint, { err, at: Date.now() });
          marker?.failed();
          throw err;
        })
        .finally(() => {
          marker?.done();
          inflight.delete(mint);
          progress.delete(mint);
        });
      const settled = p.catch(() => {}); // a poll may have stopped waiting; the failure is kept above
      deps.background?.(settled);
      inflight.set(mint, p);
    }
    return p;
  };

  // Stale-while-revalidate: a cached history is returned at once, and at most once per
  // `revalidateMs` a background build picks up any new signatures for the next request.
  const revalidateMs = deps.revalidateMs ?? 60_000;
  const lastChecked = new Map<string, number>();
  const cachedOrBuild = async (mint: string): Promise<HistoryResult | Building> => {
    const cached = await readCachedHistory(mint, deps.cache);
    if (!cached) {
      const failed = failures.get(mint);
      if (failed) {
        failures.delete(mint);
        if (Date.now() - failed.at < FAILURE_TTL_MS) throw failed.err;
      }
      if (!inflight.has(mint)) {
        const marker = await deps.cache.get<BuildMarker>("building", mint);
        if (marker && Date.now() - marker.at < markerStaleMs) return { building: marker.progress };
      }
      const wait = inflight.has(mint) ? (deps.pollWaitMs ?? 1500) : (deps.firstWaitMs ?? 15_000);
      const building = Bun.sleep(wait).then((): Building => ({ building: progress.get(mint) ?? null }));
      return Promise.race([history(mint, true), building]);
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
      if ("building" in result) {
        // Long history: answer now with how far the build has got; the page polls again.
        return Response.json(
          { status: "building", ...(result.building ?? { phase: "signatures", done: 0, total: null }) },
          { status: 202, headers: { "cache-control": "no-store", "retry-after": "2" } },
        );
      }
      return Response.json(number !== null ? { ...result, number } : result);
    } catch (err) {
      console.error("history failed:", err instanceof Error ? err.message : err);
      // RpcError messages carry the RPC's host only (redactUrl), never its key.
      if (err instanceof RpcError) return error(502, "rpc_failed", "the Solana RPC failed after retries");
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

    // The index's counts, for the home page, so they never drift from it.
    stats(): Response {
      if (!deps.index) return error(503, "no_index", "the Panda index has not been built (bun run index)");
      const { pandas, burned, duplicates, missing, generatedAt } = deps.index;
      const numbers = Math.max(0, ...[pandas, burned, duplicates].flatMap((m) => Object.keys(m).map(Number)));
      return Response.json(
        { numbers, live: deps.index.count, burned: Object.keys(burned).length, missing, generatedAt } satisfies Stats,
        { headers: { "cache-control": "public, max-age=300" } },
      );
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
