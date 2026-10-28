import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { memoryCache } from "../src/cache.ts";
import { DTP_COLLECTION_MINT, DTP_CREATORS, DTP_IMMORTAL_COLLECTION_MINT } from "../src/constants.ts";
import { buildIndex, type DasAsset } from "../src/index-lookup.ts";
import { buildLists } from "../src/lists.ts";
import type { Fetcher } from "../src/json-fetch.ts";
import type { Rpc } from "../src/rpc.ts";

type Options = { stat?: string; collection?: string; burnt?: boolean; image?: string };
const panda = (id: string, n: number, { stat, collection = DTP_COLLECTION_MINT, burnt, image }: Options = {}): DasAsset => ({
  id,
  burnt,
  grouping: [{ group_key: "collection", group_value: collection }],
  creators: [{ address: DTP_CREATORS[0], verified: true }],
  content: {
    metadata: { name: `Degen Trash Panda #${n}`, attributes: stat ? [{ trait_type: "EXALTED_STAT", value: stat }] : [] },
    links: { image: image ?? `https://arweave.net/${id}` },
  },
});

const assets: DasAsset[] = [
  panda("m1", 1),
  panda("m2", 2, { stat: "TELL_ME_A_JOKE: Mint Date" }),
  panda("m3", 3, { stat: "WEN: Soon", burnt: true }),
  panda("m4", 4, { collection: DTP_IMMORTAL_COLLECTION_MINT }),
  panda("m5", 5, { collection: DTP_IMMORTAL_COLLECTION_MINT, burnt: true }),
  // A copycat named #7, exalted, from another creator and collection: never in the index or a list.
  { ...panda("fake", 7, { stat: "RUGGED_COUNT: 9", collection: "Elsewhere" }), creators: [] },
  // An image that isn't http(s) is dropped.
  panda("m6", 6, { stat: "WEN: Never", image: "javascript:alert(1)" }),
  // Stripped of its stat, like #29: not exalted any more.
  panda("m8", 8, { stat: "EXALTED_STAT: None" }),
];
const index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATORS, "2026-10-28T00:00:00.000Z");
const lists = buildLists(assets, index);

describe("buildLists", () => {
  test("exalted comes from the EXALTED_STAT trait, with its value, burned ones flagged", () => {
    expect(lists.exalted).toEqual([
      { n: 2, mint: "m2", image: "https://arweave.net/m2", burned: false, stat: "TELL_ME_A_JOKE: Mint Date" },
      { n: 3, mint: "m3", image: "https://arweave.net/m3", burned: true, stat: "WEN: Soon" },
      { n: 6, mint: "m6", image: null, burned: false, stat: "WEN: Never" },
    ]);
  });

  test("immortal is a verified Immortal collection; burned is the index's burned", () => {
    expect(lists.immortal.map((e) => [e.n, e.burned])).toEqual([
      [4, false],
      [5, true],
    ]);
    expect(lists.burned.map((e) => e.n)).toEqual([3, 5]);
  });

  test("an emptied stat (\"EXALTED_STAT: None\") is un-exalted, not exalted", () => {
    expect(lists.exalted.some((e) => e.n === 8)).toBe(false);
    expect(lists.unexalted.map((e) => e.n)).toEqual([8]);
  });

  test("a copycat is in no list, and a non-http image is dropped", () => {
    const all = [...lists.exalted, ...lists.immortal, ...lists.burned];
    expect(all.some((e) => e.mint === "fake")).toBe(false);
    expect(lists.exalted.find((e) => e.n === 6)?.image).toBeNull();
  });
});

describe("GET /api/list/:kind", () => {
  const unused = { call: async () => { throw new Error("no RPC in these tests"); } } as Rpc;
  const api = createApi({ rpc: unused, fetcher: {} as Fetcher, cache: memoryCache(), index, lists });

  test("serves a list", async () => {
    const res = api.list("immortal");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "immortal", generatedAt: "2026-10-28T00:00:00.000Z", pandas: [{ n: 4 }, { n: 5 }] });
  });

  test("an unknown list is a 404", () => {
    expect(api.list("swapped").status).toBe(404);
  });
});
