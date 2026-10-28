import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { memoryCache } from "../src/cache.ts";
import { DTP_COLLECTION_MINT, DTP_CREATORS, DTP_IMMORTAL_COLLECTION_MINT } from "../src/constants.ts";
import { buildIndex, type DasAsset } from "../src/index-lookup.ts";
import { buildLists } from "../src/lists.ts";
import type { Fetcher } from "../src/json-fetch.ts";
import type { Rpc } from "../src/rpc.ts";

type Options = { stat?: string; collection?: string; burnt?: boolean; image?: string; jsonUri?: string; traits?: Record<string, string> };
const panda = (id: string, n: number, { stat, collection = DTP_COLLECTION_MINT, burnt, image, jsonUri, traits = {} }: Options = {}): DasAsset => ({
  id,
  burnt,
  grouping: [{ group_key: "collection", group_value: collection }],
  creators: [{ address: DTP_CREATORS[0], verified: true }],
  content: {
    metadata: {
      name: `Degen Trash Panda #${n}`,
      attributes: [
        ...Object.entries(traits).map(([trait_type, value]) => ({ trait_type, value })),
        ...(stat ? [{ trait_type: "EXALTED_STAT", value: stat }] : []),
      ],
    },
    links: { image: image ?? `https://arweave.net/${id}` },
    json_uri: jsonUri ?? `https://arweave.net/${id}.json`,
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
  // Moved off the collection unverified, like #5642: DAS reports no grouping.
  { ...panda("m9", 9), grouping: [] },
  // Metadata still on Shadow Drive, like #15639.
  panda("m10", 10, { image: "https://shdw-drive.genesysgo.net/x/10.png", jsonUri: "https://shdw-drive.genesysgo.net/x/10.json" }),
];
const index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATORS, "2026-10-28T00:00:00.000Z");
const lists = buildLists(assets, index, new Map([["m9", DTP_IMMORTAL_COLLECTION_MINT]]));

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

  test("unverified: in neither collection as verified, with where its metadata account points", () => {
    expect(lists.unverified).toEqual([
      { n: 9, mint: "m9", image: "https://arweave.net/m9", burned: false, note: "In the Immortal collection, unverified" },
    ]);
  });

  test("lost: metadata or art still on Shadow Drive", () => {
    expect(lists.lost.map((e) => [e.n, e.note])).toEqual([[10, "Metadata and art"]]);
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

describe("original: six traits against the mint", () => {
  const six = { HEAD: "Sock", BODY: "T-Shirt", MOUTH: "Cigar - Grin", GLASSES: "No Traits", BACKGROUND: "Red", FUR: "Red - Grin" };
  const swapped = { ...six, HEAD: "Crown" };
  const traitAssets = [
    panda("o1", 1, { stat: "WEN: Soon", traits: six }),
    panda("o2", 2, { stat: "WEN: Soon", traits: swapped }),
    panda("o3", 3, { stat: "WEN: Soon", traits: six }),
    panda("o4", 4, { stat: "WEN: Soon", traits: six, jsonUri: "https://shdw-drive.genesysgo.net/x/4.json" }),
  ];
  const traitIndex = buildIndex(traitAssets, DTP_COLLECTION_MINT, DTP_CREATORS, "2026-10-28T00:00:00.000Z");
  const mint = { traits: six };
  const traitLists = buildLists(traitAssets, traitIndex, new Map(), { "1": mint, "2": mint, "3": { error: "metadata unreadable" }, "4": mint });
  const byN = new Map(traitLists.exalted.map((e) => [e.n, e.original]));

  test("all six the same is original; any swap isn't", () => {
    expect(byN.get(1)).toBe(true);
    expect(byN.get(2)).toBe(false);
  });

  test("unknown when the mint traits or the current ones can't be read", () => {
    expect(byN.get(3)).toBeUndefined();
    expect(byN.get(4)).toBeUndefined();
  });
});
