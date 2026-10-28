// Writes data/metadata-snapshot.json: where every Panda's on-chain metadata points (its URI) and
// which collection it's in, read straight from the metadata accounts rather than from DAS. About
// 200 batched getMultipleAccounts calls. Re-run after a collection-wide update (like the October
// 2026 move off Shadow Drive) to see what changed without rebuilding histories.
import { DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT } from "../src/constants.ts";
import { loadConfig, redactUrl } from "../src/config.ts";
import { decodeMetadataAccount } from "../src/decode/metadata-account.ts";
import type { PandaIndex } from "../src/index-lookup.ts";
import { metadataPda } from "../src/pda.ts";
import { createRpc } from "../src/rpc.ts";

const ROOT = `${import.meta.dir}/..`;
const OUT = `${ROOT}/data/metadata-snapshot.json`;

// "main"/"immortal" are the two DTP collections; "-unverified" when the Panda sits in one without
// being verified; "other" for any other collection; null for none. A burned Panda whose metadata
// account is gone has `account: false` and nothing else.
type Collection = "main" | "immortal" | "main-unverified" | "immortal-unverified" | "other" | null;
type Entry = { mint: string; account: false } | { mint: string; uri: string; collection: Collection };

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL (e.g. Helius).");
  process.exit(1);
}
const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: config.rpcRps });
console.log(`Reading metadata accounts via ${redactUrl(config.rpcUrl)}`);

const index = (await Bun.file(`${ROOT}/data/panda-index.json`).json()) as PandaIndex;
const pandas = [...Object.entries(index.pandas), ...Object.entries(index.burned)]
  .map(([n, mint]) => ({ n: Number(n), mint }))
  .sort((a, b) => a.n - b.n);

function collectionOf(c: { key: string; verified: boolean } | null): Collection {
  if (!c) return null;
  const which = c.key === DTP_COLLECTION_MINT ? "main" : c.key === DTP_IMMORTAL_COLLECTION_MINT ? "immortal" : null;
  if (!which) return "other";
  return c.verified ? which : `${which}-unverified`;
}

const entries: Record<string, Entry> = {};
for (let i = 0; i < pandas.length; i += 100) {
  const batch = pandas.slice(i, i + 100);
  const pdas = await Promise.all(batch.map((p) => metadataPda(p.mint)));
  const res = await rpc.call<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [pdas, { encoding: "base64" }]);
  res.value.forEach((account, j) => {
    const { n, mint } = batch[j]!;
    if (!account) {
      entries[n] = { mint, account: false };
      return;
    }
    const md = decodeMetadataAccount(Buffer.from(account.data[0], "base64"));
    entries[n] = { mint, uri: md.data.uri, collection: collectionOf(md.collection) };
  });
}

const hosts: Record<string, number> = {};
for (const e of Object.values(entries)) {
  const host = "uri" in e ? new URL(e.uri).host : "(no account)";
  hosts[host] = (hosts[host] ?? 0) + 1;
}
// One Panda per line, so a re-run's diff shows exactly which Pandas moved.
const lines = Object.entries(entries).map(([n, e]) => `    ${JSON.stringify(n)}: ${JSON.stringify(e)}`);
await Bun.write(
  OUT,
  `{\n  "generatedAt": ${JSON.stringify(new Date().toISOString())},\n  "hosts": ${JSON.stringify(hosts)},\n  "pandas": {\n${lines.join(",\n")}\n  }\n}\n`,
);
console.log(`${Object.keys(entries).length} Pandas. Metadata hosts: ${JSON.stringify(hosts)}`);
