// Builds data/panda-index.json from DAS: `getAssetsByGroup` (the verified collection),
// `getAssetsByCreator` (each verified DTP creator, for Pandas whose collection field is wrong) and
// `searchAssets` with `burnt` (neither of the others returns burned assets). Needs RPC_URL pointing
// at a DAS-capable endpoint (e.g. Helius). The URL and key are never written to the file.
//
// DAS leaves out of every listing a Panda whose token was burned with a plain token burn (supply 0,
// metadata left behind). Those are kept in data/extra-mints.json and fetched by id. Any number the
// previous index had but this build lost is looked up by id too, and added to that file if found,
// so a Panda burned this way between builds becomes burned instead of missing.
import { DTP_COLLECTION_MINT, DTP_CREATORS, DTP_IMMORTAL_COLLECTION_MINT } from "../src/constants.ts";
import { decodeMetadataAccount } from "../src/decode/metadata-account.ts";
import { metadataPda } from "../src/pda.ts";
import { loadConfig, redactUrl } from "../src/config.ts";
import { buildIndex, lostMints, type DasAsset, type PandaIndex } from "../src/index-lookup.ts";
import { memoryCache } from "../src/cache.ts";
import { buildHistory } from "../src/history.ts";
import { createFetcher } from "../src/json-fetch.ts";
import { buildLists, LIST_KINDS, LOST_HOST, type MintTraitsByNumber } from "../src/lists.ts";
import { createRpc, RpcError } from "../src/rpc.ts";
import { sourcesFor } from "../src/thumb.ts";

// Arweave and ArDrive both serve any Arweave id; try the other when one fails (see src/thumb.ts).
const sourcesForJson = (uri: string) => {
  try {
    return sourcesFor(uri);
  } catch {
    return [uri];
  }
};

const OUT = `${import.meta.dir}/../data/panda-index.json`;
const EXTRA = `${import.meta.dir}/../data/extra-mints.json`;
const LISTS = `${import.meta.dir}/../data/lists.json`;
const LIMIT = 1000;

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL to a DAS-capable endpoint (e.g. Helius).");
  process.exit(1);
}

const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: config.rpcRps });
console.log(`Paging collection ${DTP_COLLECTION_MINT} and creators ${DTP_CREATORS.join(", ")} via ${redactUrl(config.rpcUrl)}`);

async function pageAll(method: string, params: Record<string, unknown>): Promise<DasAsset[]> {
  const assets: DasAsset[] = [];
  for (let page = 1; ; page++) {
    const result = await rpc.call<{ items: DasAsset[] }>(method, { ...params, page, limit: LIMIT });
    assets.push(...result.items);
    console.log(`${method} page ${page}: ${result.items.length}`);
    if (result.items.length < LIMIT) return assets;
  }
}

const assets = [
  ...(await pageAll("getAssetsByGroup", { groupKey: "collection", groupValue: DTP_COLLECTION_MINT })),
  ...(await pageAll("searchAssets", { grouping: ["collection", DTP_COLLECTION_MINT], burnt: true })),
];
for (const creator of DTP_CREATORS) {
  assets.push(...(await pageAll("getAssetsByCreator", { creatorAddress: creator, onlyVerified: true })));
  assets.push(...(await pageAll("searchAssets", { creatorAddress: creator, creatorVerified: true, burnt: true })));
}

// DAS still knows a delisted Panda by id. An NFT's supply is 1: 0 means the token was burned, and a
// closed mint account (-32602) has no supply left at all.
async function byId(mint: string): Promise<DasAsset> {
  const asset = await rpc.call<DasAsset>("getAsset", { id: mint });
  let supply: string | null = null;
  try {
    supply = (await rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint])).value.amount;
  } catch (err) {
    if (!(err instanceof RpcError && err.message.includes("-32602"))) throw err;
  }
  return { ...asset, burnt: asset.burnt || supply !== "1" };
}

const extra = (await Bun.file(EXTRA).json()) as { mint: string; note: string }[];
for (const { mint } of extra) assets.push(await byId(mint));
console.log(`extra mints: ${extra.length}`);

const generatedAt = new Date().toISOString();
let index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATORS, generatedAt);

const previous = (await Bun.file(OUT).exists()) ? ((await Bun.file(OUT).json()) as PandaIndex) : null;
const lost = previous ? lostMints(previous, index) : [];
if (lost.length) {
  for (const { mint } of lost) assets.push(await byId(mint));
  index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATORS, generatedAt);
  for (const { n, mint } of lost) {
    const found = index.pandas[n] === mint || index.burned[n] === mint;
    console.log(`#${n} was in the last index but not listed by DAS: ${found ? "found by id" : "still missing"} (${mint})`);
    if (found) extra.push({ mint, note: `#${n}, found by id on ${generatedAt.slice(0, 10)}` });
  }
  await Bun.write(EXTRA, `${JSON.stringify(extra, null, 2)}\n`);
}

await Bun.write(OUT, `${JSON.stringify(index)}\n`);
// DAS only reports verified collections, so for the few Pandas in neither DTP collection, read the
// collection their metadata account holds.
const indexed = new Set([...Object.values(index.pandas), ...Object.values(index.burned)]);
const offCollection = [...new Set(assets.filter((a) => indexed.has(a.id)).map((a) => a.id))].filter(
  (id) =>
    !assets.some(
      (a) => a.id === id && a.grouping?.some((g) => g.group_key === "collection" && [DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT].includes(g.group_value)),
    ),
);
const collections = new Map<string, string | null>();
for (const mint of offCollection) {
  const info = await rpc.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [await metadataPda(mint), { encoding: "base64" }]);
  collections.set(mint, info.value ? (decodeMetadataAccount(Buffer.from(info.value.data[0], "base64")).collection?.key ?? null) : null);
}
// Mint-day traits (scripts/mint-traits.ts), to mark grid Pandas whose traits were never swapped.
const MINT_TRAITS = `${import.meta.dir}/../data/mint-traits.json`;
const mintTraits = (await Bun.file(MINT_TRAITS).exists()) ? ((await Bun.file(MINT_TRAITS).json()) as { pandas: MintTraitsByNumber }).pandas : {};
// DAS hasn't read every Panda's metadata file (e.g. 15 Immortals have no image or traits there), so
// read those few here, before the lists compare traits. Shadow Drive files are gone; skip them.
const unread = new Map<string, string>();
for (const a of assets) {
  const uri = a.content?.json_uri;
  if (!indexed.has(a.id) || !uri || new URL(uri).host === LOST_HOST) continue;
  if (!a.content?.links?.image || !a.content.metadata?.attributes?.length) unread.set(a.id, uri);
}
const readFiles = new Map<string, { image?: unknown; attributes?: unknown }>();
for (const [mint, uri] of unread) {
  for (const url of sourcesForJson(uri)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        readFiles.set(mint, await res.json());
        break;
      }
    } catch {
      // try the next gateway
    }
  }
  if (!readFiles.has(mint)) console.log(`${mint}: metadata unreadable (${uri})`);
}
for (const a of assets) {
  const json = readFiles.get(a.id);
  if (!json || !a.content) continue;
  if (typeof json.image === "string" && /^https?:\/\//.test(json.image)) a.content.links = { ...a.content.links, image: json.image };
  if (Array.isArray(json.attributes)) a.content.metadata = { ...a.content.metadata, attributes: json.attributes };
}
console.log(`metadata read directly: ${readFiles.size} of ${unread.size}`);

const lists = buildLists(assets, index, collections, mintTraits);
// Art last hosted on Shadow Drive is gone, but a history can still hold earlier art: show that
// instead. Only a handful of Pandas, so building their histories here is cheap.
const lostArt = new Map<string, { image: string; at: string } | null>();
for (const entry of LIST_KINDS.flatMap((k) => lists[k])) {
  if (!entry.image || new URL(entry.image).host !== LOST_HOST) continue;
  if (!lostArt.has(entry.mint)) {
    const cache = memoryCache();
    const history = await buildHistory(entry.mint, { rpc, fetcher: createFetcher(cache), cache });
    const step = history.steps.findLast((s) => s.json && s.image && new URL(s.image).host !== LOST_HOST);
    lostArt.set(entry.mint, step?.image && step.dateUtc ? { image: step.image, at: step.dateUtc } : null);
    console.log(`#${entry.n}: art lost; ${step ? `last readable art ${step.dateUtc?.slice(0, 10)}` : "no readable art in its history"}`);
  }
  const art = lostArt.get(entry.mint);
  if (art) entry.lastArt = art;
}
await Bun.write(LISTS, `${JSON.stringify(lists)}\n`);
console.log(
  `count ${index.count}, duplicates ${Object.keys(index.duplicates).length}, burned ${Object.keys(index.burned).length}, ` +
    `missing ${index.missing.length}, unparsed ${index.unparsed.length}`,
);
console.log(
  `lists: ${LIST_KINDS.map((k) => `${k} ${lists[k].length}`).join(", ")}`,
);
if (index.count < 10_000) {
  console.error(`count ${index.count} is below 10000: paging probably failed`);
  process.exit(1);
}
