import { buildHistory, type Deps, type HistoryResult } from "./history.ts";
import { parseInput, resolve, type PandaIndex } from "./index-lookup.ts";
import { RpcError } from "./rpc.ts";

type ApiDeps = Deps & { index: PandaIndex | null };

// Route handlers, kept apart from Bun.serve so tests can call them directly.
export function createApi(deps: ApiDeps) {
  // Concurrent requests for the same mint share one build.
  const inflight = new Map<string, Promise<HistoryResult>>();
  const history = (mint: string): Promise<HistoryResult> => {
    let p = inflight.get(mint);
    if (!p) {
      p = buildHistory(mint, deps).finally(() => inflight.delete(mint));
      inflight.set(mint, p);
    }
    return p;
  };

  async function respond(mint: string, number: number | null): Promise<Response> {
    try {
      const result = await history(mint);
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
