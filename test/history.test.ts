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

describe("metadata that can no longer be fetched", () => {
  test("a change made during the gap shows at the first readable step after it", async () => {
    const base = await fixtureFetcher();
    const gone = new Set(["ar:dEdDE4RR-nq_MqxJ-c_DOlkHDFwCvP0GmVWlJpVWdrU", "ar:HK4b1FL5AdkncwPpN8D0KWUmqsxyVxAITb78t95xLrQ"]);
    const fetcher: Fetcher = {
      ...base,
      async json(uri) {
        const key = normalizeUri(uri).key;
        if (gone.has(key)) return { json: null, error: "HTTP 404 from shdw-drive.genesysgo.net" };
        const result = await base.json(uri);
        // Today's metadata has a different HEAD than at mint.
        if (key === "ar:TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k" && result.json) {
          const attrs = result.json.attributes as { trait_type: string; value: unknown }[];
          result.json.attributes = attrs.map((a) => (a.trait_type === "HEAD" ? { ...a, value: "Gold Crown" } : a));
        }
        return result;
      },
    };
    const { rpc } = await fixtureRpc();
    const result = await buildHistory(MINT_6872, { rpc, fetcher, cache: memoryCache() });

    expect(result.verdict).toBe("Traits/art changed");
    const after = result.steps.find((s) => s.dateUtc === "2026-10-12")!;
    expect(after.diff).toContainEqual({ path: "attributes.HEAD", from: "Headband", to: "Gold Crown", tag: "swap" });
    // The last readable metadata was at mint (both 2021-11-23 steps share the mint URI).
    expect(new Date(after.gapSince! * 1000).toISOString().slice(0, 10)).toBe("2021-11-23");
    // Steps inside the gap have no JSON diff, and readable neighbours have no gap.
    const inGap = result.steps.filter((s) => s.jsonError);
    expect(inGap.length).toBeGreaterThan(0);
    expect(inGap.every((s) => s.diff.every((c) => !c.path.startsWith("attributes.")))).toBe(true);
    expect(result.steps[1]!.gapSince).toBeNull();
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

  test("cached histories are served without waiting on the RPC, then revalidated in the background", async () => {
    const cache = memoryCache();
    const fetcher = await fixtureFetcher();
    const { rpc, calls } = await fixtureRpc();
    const a = createApi({ rpc, fetcher, cache, index, revalidateMs: 60_000 });

    expect((await a.mint(MINT_6872)).status).toBe(200); // cold: full build
    const coldCalls = calls.length;

    // Warm: the RPC hangs, but the cached answer still comes straight back.
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: Rpc = { call: async (m, p) => (await gate, rpc.call(m, p)) };
    const b = createApi({ rpc: slow, fetcher, cache, index, revalidateMs: 60_000 });
    const warm = await b.mint(MINT_6872);
    expect(warm.status).toBe(200);
    expect(((await warm.json()) as { verdict: string }).verdict).toBe("Original");

    // A second request inside the window does not start another check.
    await b.mint(MINT_6872);
    release();
    await Bun.sleep(10);
    expect(calls.length).toBe(coldCalls + 1); // one getSignaturesForAddress(limit 1) from the single revalidate
  });

  test("every new build is handed to background, so a serverless host keeps it running", async () => {
    const handed: Promise<unknown>[] = [];
    const cache = memoryCache();
    const deps = { fetcher: await fixtureFetcher(), cache, index, background: (w: Promise<unknown>) => handed.push(w) };

    // Cold: the build that answers the request.
    const a = createApi({ ...deps, rpc: (await fixtureRpc()).rpc });
    expect((await a.mint(MINT_6872)).status).toBe(200);
    expect(handed).toHaveLength(1);

    // Warm: the cached answer is returned and the revalidate runs after it.
    const b = createApi({ ...deps, rpc: (await fixtureRpc()).rpc, revalidateMs: 0 });
    expect((await b.mint(MINT_6872)).status).toBe(200);
    expect(handed).toHaveLength(2);
    await Promise.all(handed); // settles even if a build fails, so waitUntil never sees a rejection
  });

  // Two createApi instances sharing one cache stand in for two copies of the server on Vercel.
  async function gatedRpc() {
    const { rpc, calls } = await fixtureRpc();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: Rpc = { call: async (m, p) => (await gate, rpc.call(m, p)) };
    return { rpc: slow, calls, release };
  }

  test("a poll on another copy reports the build in progress instead of starting a second build", async () => {
    const cache = memoryCache();
    const fetcher = await fixtureFetcher();
    const owner = await gatedRpc();
    const a = createApi({ rpc: owner.rpc, fetcher, cache, index, firstWaitMs: 10, pollWaitMs: 10 });
    expect((await a.mint(MINT_6872)).status).toBe(202);

    const other = await fixtureRpc();
    const b = createApi({ rpc: other.rpc, fetcher, cache, index, revalidateMs: Infinity });
    const poll = await b.mint(MINT_6872);
    expect(poll.status).toBe(202);
    expect(await poll.json()).toMatchObject({ status: "building" });

    owner.release();
    while ((await a.mint(MINT_6872)).status === 202) await Bun.sleep(5);
    expect((await b.mint(MINT_6872)).status).toBe(200); // the owner's result, from the cache
    expect(other.calls).toHaveLength(0);
  });

  test("a marker that stopped being rewritten is abandoned, and the next poll builds", async () => {
    const cache = memoryCache();
    const fetcher = await fixtureFetcher();
    const owner = await gatedRpc(); // never released: this copy is "frozen"
    const a = createApi({ rpc: owner.rpc, fetcher, cache, index, firstWaitMs: 10, heartbeatMs: 60_000, markerStaleMs: 30 });
    expect((await a.mint(MINT_6872)).status).toBe(202);

    await Bun.sleep(50);
    const other = await fixtureRpc();
    const b = createApi({ rpc: other.rpc, fetcher, cache, index, markerStaleMs: 30 });
    expect((await b.mint(MINT_6872)).status).toBe(200);
    expect(other.calls.length).toBeGreaterThan(0);
  });

  test("a failed build leaves no marker in the way: another copy retries at once", async () => {
    const cache = memoryCache();
    const fetcher = await fixtureFetcher();
    const failing: Rpc = {
      call: async () => {
        throw new RpcError("getSignaturesForAddress failed (status 429)");
      },
    };
    const a = createApi({ rpc: failing, fetcher, cache, index });
    expect((await a.mint(MINT_6872)).status).toBe(502);
    await Bun.sleep(5); // the stale marker is written as the failure settles

    const b = createApi({ rpc: (await fixtureRpc()).rpc, fetcher, cache, index });
    expect((await b.mint(MINT_6872)).status).toBe(200);
  });

  test("GET /api/random picks a number from the index", async () => {
    const a = await api();
    const res = a.random(() => 0.5);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 6872 }); // #7 is a duplicate, so 6872 is the only entry
    const none = createApi({ rpc: (await fixtureRpc()).rpc, fetcher: await fixtureFetcher(), cache: memoryCache(), index: null });
    expect(none.random().status).toBe(503);
  });

  test("a slow build answers 202 with progress, then the result", async () => {
    const { rpc } = await fixtureRpc();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // Hold every getTransaction until released, so the build sits in the transactions phase.
    const slow: Rpc = {
      call: async (method, params) => {
        if (method === "getTransaction") await gate;
        return rpc.call(method, params);
      },
    };
    const a = createApi({ rpc: slow, fetcher: await fixtureFetcher(), cache: memoryCache(), index, firstWaitMs: 30, pollWaitMs: 10 });

    const first = await a.mint(MINT_6872);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "building", phase: "transactions", done: 0, total: 55 });

    release();
    let done: Response | undefined;
    for (let i = 0; i < 50 && !done; i++) {
      const res = await a.mint(MINT_6872);
      if (res.status === 200) done = res;
    }
    expect(done?.status).toBe(200);
    expect(((await done!.json()) as { verdict: string }).verdict).toBe("Original");
  });

  test("a background build that fails is reported to the next poll, once", async () => {
    const failing: Rpc = {
      call: async () => {
        await Bun.sleep(20);
        throw new RpcError("getSignaturesForAddress failed (status 429) via https://rpc.example/<redacted>");
      },
    };
    const a = createApi({ rpc: failing, fetcher: await fixtureFetcher(), cache: memoryCache(), index, firstWaitMs: 5, pollWaitMs: 5 });
    expect((await a.mint(MINT_6872)).status).toBe(202);
    await Bun.sleep(40);
    expect((await a.mint(MINT_6872)).status).toBe(502);
  });
});
