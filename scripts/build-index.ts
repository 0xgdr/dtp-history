// Builds data/panda-index.json from DAS: `getAssetsByGroup` (the verified collection),
// `getAssetsByCreator` (each verified DTP creator, for Pandas whose collection field is wrong) and
// `searchAssets` with `burnt` (neither of the others returns burned assets). Needs RPC_URL pointing
// at a DAS-capable endpoint (e.g. Helius). The URL and key are never written to the file.
//
// DAS leaves out of every listing a Panda whose token was burned with a plain token burn (supply 0,
// metadata left behind), so those are listed by hand in data/extra-mints.json and fetched by id.
import { DTP_COLLECTION_MINT, DTP_CREATORS } from "../src/constants.ts";
import { loadConfig, redactUrl } from "../src/config.ts";
import { buildIndex, type DasAsset } from "../src/index-lookup.ts";
import { createRpc } from "../src/rpc.ts";

const OUT = `${import.meta.dir}/../data/panda-index.json`;
const EXTRA = `${import.meta.dir}/../data/extra-mints.json`;
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

const extra = (await Bun.file(EXTRA).json()) as { mint: string; note: string }[];
for (const { mint } of extra) {
  const asset = await rpc.call<DasAsset>("getAsset", { id: mint });
  const supply = await rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint]);
  assets.push({ ...asset, burnt: asset.burnt || supply.value.amount === "0" });
}
console.log(`extra mints: ${extra.length}`);

const index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATORS, new Date().toISOString());
await Bun.write(OUT, `${JSON.stringify(index)}\n`);
console.log(
  `count ${index.count}, duplicates ${Object.keys(index.duplicates).length}, burned ${Object.keys(index.burned).length}, ` +
    `missing ${index.missing.length}, unparsed ${index.unparsed.length}`,
);
if (index.count < 10_000) {
  console.error(`count ${index.count} is below 10000: paging probably failed`);
  process.exit(1);
}
