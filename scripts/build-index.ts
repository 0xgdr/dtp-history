// Builds data/panda-index.json from DAS `getAssetsByGroup` (the verified collection) plus
// `getAssetsByCreator` (the verified DTP creator, for Pandas whose collection field is wrong). Needs RPC_URL pointing at a
// DAS-capable endpoint (e.g. Helius). The URL and key are never written to the file.
import { DTP_COLLECTION_MINT, DTP_CREATOR } from "../src/constants.ts";
import { loadConfig, redactUrl } from "../src/config.ts";
import { buildIndex, type DasAsset } from "../src/index-lookup.ts";
import { createRpc } from "../src/rpc.ts";

const OUT = `${import.meta.dir}/../data/panda-index.json`;
const LIMIT = 1000;

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL to a DAS-capable endpoint (e.g. Helius).");
  process.exit(1);
}

const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: config.rpcRps });
console.log(`Paging collection ${DTP_COLLECTION_MINT} and creator ${DTP_CREATOR} via ${redactUrl(config.rpcUrl)}`);

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
  ...(await pageAll("getAssetsByCreator", { creatorAddress: DTP_CREATOR, onlyVerified: true })),
];

const index = buildIndex(assets, DTP_COLLECTION_MINT, DTP_CREATOR, new Date().toISOString());
await Bun.write(OUT, `${JSON.stringify(index)}\n`);
console.log(
  `count ${index.count}, duplicates ${Object.keys(index.duplicates).length}, burned ${Object.keys(index.burned).length}, ` +
    `missing ${index.missing.length}, unparsed ${index.unparsed.length}`,
);
if (index.count < 10_000) {
  console.error(`count ${index.count} is below 10000: paging probably failed`);
  process.exit(1);
}
