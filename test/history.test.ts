import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { memoryCache } from "../src/cache.ts";
import { buildIndex } from "../src/index-lookup.ts";
import { buildHistory, type SigInfo } from "../src/history.ts";
import type { Fetcher } from "../src/json-fetch.ts";
import { RpcError, type Rpc } from "../src/rpc.ts";
import type { Json } from "../src/traits.ts";
import type { RawTransaction } from "../src/tx.ts";
import { normalizeUri } from "../src/uri.ts";
import { MINT_6872, PDA_6872, fixture } from "./helpers.ts";

const DIR = `${import.meta.dir}/fixtures/6872`;
const TRSH = "trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH";

// Recorded txs by signature. Signatures without a fixture had no Token Metadata instruction on
// the PDA when the fixtures were recorded, so an empty tx stands in for them.
async function loadTxs(): Promise<Map<string, RawTransaction>> {
  const txs = new Map<string, RawTransaction>();
  for (const name of new Bun.Glob("tx-*.json").scanSync(DIR)) {
    const tx = await fixture<RawTransaction>(name);
    txs.set(tx.transaction.signatures[0]!, tx);
  }
  return txs;
}

function emptyTx(info: SigInfo): RawTransaction {
  return {
    slot: info.slot,
    blockTime: info.blockTime,
    transaction: {
      signatures: [info.signature],
      message: { accountKeys: [], header: { numRequiredSignatures: 0 }, instructions: [] },
    },
    meta: { err: null },
  };
}

async function fixtureRpc(overrides: { signatures?: SigInfo[]; account?: unknown; dropTx?: string } = {}) {
  const signatures = overrides.signatures ?? (await fixture<SigInfo[]>("signatures.json"));
  const account = overrides.account ?? (await fixture("account.json"));
  const txs = await loadTxs();
  const calls: string[] = [];
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown): Promise<T> {
      calls.push(method);
      const [first, opts] = params as [string, { limit?: number; before?: string }];
      if (method === "getSignaturesForAddress") {
        expect(first).toBe(PDA_6872);
        const start = opts.before ? signatures.findIndex((s) => s.signature === opts.before) + 1 : 0;
        return signatures.slice(start, start + (opts.limit ?? 1000)) as T;
      }
      if (method === "getTransaction") {
        if (first === overrides.dropTx) return null as T;
        const info = signatures.find((s) => s.signature === first)!;
        return (txs.get(first) ?? emptyTx(info)) as T;
      }
      if (method === "getAccountInfo") return account as T;
      throw new Error(`unexpected ${method}`);
    },
  };
  return { rpc, calls };
}

async function fixtureFetcher(): Promise<Fetcher> {
  const jsons = new Map<string, Json>();
  for (const name of new Bun.Glob("json-*.json").scanSync(DIR)) {
    jsons.set(`ar:${name.slice(5, -5)}`, await fixture<Json>(name));
  }
  return {
    async json(uri) {
      const json = jsons.get(normalizeUri(uri).key);
      return json ? { json: structuredClone(json), error: null } : { json: null, error: "not in fixtures" };
    },
    async imageHash() {
      throw new Error("all #6872 images share one Arweave ID, so no bytes should be fetched");
    },
  };
}

describe("#6872 full pipeline", () => {
  test("Original, with the expected steps in order", async () => {
    const { rpc } = await fixtureRpc();
    const result = await buildHistory(MINT_6872, { rpc, fetcher: await fixtureFetcher(), cache: memoryCache() });

    expect(result.verdict).toBe("Original");
    expect(result.number).toBe(6872);
    expect(result.metadataPda).toBe(PDA_6872);
    expect(result.historyIncomplete).toBe(false);
    expect(result.baselineUncertain).toBe(false);
    expect(result.changedInHistory).toBe(false);
    expect(result.burned).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.signaturesScanned).toBe(55);

    expect(result.steps.map((s) => [s.dateUtc, s.kind])).toEqual([
      ["2021-11-23", "CreateMetadataAccount"],
      ["2021-11-23", "UpdateMetadataAccount"],
      ["2021-11-27", "UpdateMetadataAccount"],
      ["2021-11-29", "UpdateMetadataAccount"],
      ["2022-06-02", "UpdateMetadataAccount"],
      ["2022-10-09", "UpdateMetadataAccount"],
      ["2023-07-14", "Update"],
      ["2023-07-14", "Update"],
      ["2026-10-12", "Update"],
      ["2026-10-13", "Update"],
    ]);

    const first = result.steps[0]!;
    expect(first.uri).toBe("https://arweave.net/wS8w3NFld2wyvTQDyeyiirGMgOD7mrh82wPzxVbXuQY");
    expect(first.json).not.toBeNull();
    expect(first.diff).toEqual([]);

    const last = result.steps.at(-1)!;
    expect(last.uri).toBe("https://ardrive.net/TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k");
    expect(last.state.updateAuthority).toBe("7v4VH5LVbqHqv9EXaakFBedD6eoeXS9K8M9BMVhu5DcE");
    expect(result.current.jsonUri).toBe(last.uri);

    expect(result.steps.flatMap((s) => s.diff).every((c) => c.tag === "cosmetic")).toBe(true);
    expect(result.steps.flatMap((s) => [s.authority, ...s.txSigners])).toContain(TRSH);
    expect(result.otherMetadataIx.map((o) => o.kind)).toEqual(["Other(10)", "Other(25)", "Other(56)", "Other(54)"]);
  });

  test("the 2026-10-12 step shows the creators change and the ardrive move", async () => {
    const { rpc } = await fixtureRpc();
    const result = await buildHistory(MINT_6872, { rpc, fetcher: await fixtureFetcher(), cache: memoryCache() });
    const step = result.steps.find((s) => s.dateUtc === "2026-10-12")!;
    const paths = step.diff.map((c) => c.path);
    expect(paths).toContain("uri");
    expect(paths.some((p) => p.startsWith("creators."))).toBe(true);
    // New JSON on a new Arweave ID, but the image and traits are unchanged.
    expect(step.diff.filter((c) => c.tag === "swap")).toEqual([]);
  });

  test("a cached history is served when no new signature exists", async () => {
    const cache = memoryCache();
    const fetcher = await fixtureFetcher();
    await buildHistory(MINT_6872, { rpc: (await fixtureRpc()).rpc, fetcher, cache });
    const { rpc, calls } = await fixtureRpc();
    const again = await buildHistory(MINT_6872, { rpc, fetcher, cache });
    expect(again.verdict).toBe("Original");
    expect(calls).toEqual(["getSignaturesForAddress"]);
  });

  test("an unavailable tx marks the history incomplete and is not cached", async () => {
    const signatures = await fixture<SigInfo[]>("signatures.json");
    const create = (await loadTxs()).values().find((t) => t.blockTime === 1637695176)!;
    const cache = memoryCache();
    const { rpc } = await fixtureRpc({ signatures, dropTx: create.transaction.signatures[0] });
    const result = await buildHistory(MINT_6872, { rpc, fetcher: await fixtureFetcher(), cache });
    expect(result.historyIncomplete).toBe(true);
    expect(result.baselineUncertain).toBe(true);
    expect(result.unavailableSignatures).toEqual([create.transaction.signatures[0]!]);
    expect(await cache.get("history", MINT_6872)).toBeNull();
  });

  test("a missing account means burned", async () => {
    const { rpc } = await fixtureRpc({ account: { value: null } });
    const result = await buildHistory(MINT_6872, { rpc, fetcher: await fixtureFetcher(), cache: memoryCache() });
    expect(result.burned).toBe(true);
    expect(result.steps).toHaveLength(10);
  });
});

describe("API", () => {
  const index = buildIndex(
    [
      { id: MINT_6872, content: { metadata: { name: "Degen Trash Panda #6872" } }, grouping: [{ group_key: "collection", group_value: "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb" }] },
      { id: "Dup1111111111111111111111111111111", content: { metadata: { name: "Degen Trash Panda #7" } }, grouping: [{ group_key: "collection", group_value: "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb" }] },
      { id: "Dup2222222222222222222222222222222", content: { metadata: { name: "Degen Trash Panda #7" } }, grouping: [{ group_key: "collection", group_value: "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb" }] },
    ],
    "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb",
    "2026-10-20T00:00:00.000Z",
  );

  async function api() {
    return createApi({ rpc: (await fixtureRpc()).rpc, fetcher: await fixtureFetcher(), cache: memoryCache(), index });
  }

  test("GET /api/panda/%236872 resolves through the index", async () => {
    const res = await (await api()).panda("%236872");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mint: string; verdict: string; number: number };
    expect(body).toMatchObject({ mint: MINT_6872, verdict: "Original", number: 6872 });
  });

  test("error statuses", async () => {
    const a = await api();
    expect((await a.panda("abc")).status).toBe(400);
    expect((await a.panda("100")).status).toBe(404);
    expect((await a.panda("1")).status).toBe(404);
    const dup = await a.panda("7");
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { candidates: string[] }).candidates).toHaveLength(2);
    expect((await a.mint("6872")).status).toBe(400);
  });

  test("RPC failure is a 502 that hides the RPC URL", async () => {
    const failing: Rpc = {
      call: async () => {
        throw new RpcError("getSignaturesForAddress failed (status 429) via https://rpc.example/<redacted>");
      },
    };
    const a = createApi({ rpc: failing, fetcher: await fixtureFetcher(), cache: memoryCache(), index });
    const res = await a.mint(MINT_6872);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("rpc.example");
  });
});
