// Records the #6872 test fixtures into test/fixtures/6872/. Needs RPC_URL.
// Writes public chain data only: the RPC URL and key never go into any file.
import { loadConfig, redactUrl } from "../src/config.ts";
import { decodeMetadataEvents } from "../src/decode/metadata-ix.ts";
import { metadataPda } from "../src/pda.ts";
import { createRpc } from "../src/rpc.ts";
import { flattenTransaction, type RawTransaction } from "../src/tx.ts";
import { gatewayUrls, normalizeUri } from "../src/uri.ts";

const MINT = "p1kGTLmPty2LxRn5MG5AqqPJQQaxmALzQPQ7xc4bUrf";
const OUT = `${import.meta.dir}/../test/fixtures/6872`;

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL (e.g. RPC_URL=https://api.mainnet-beta.solana.com).");
  process.exit(1);
}

const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: config.rpcRps });
const pda = await metadataPda(MINT);
console.log(`PDA ${pda} via ${redactUrl(config.rpcUrl)}`);

type SigInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };
const signatures: SigInfo[] = [];
for (let before: string | undefined; ; ) {
  const page = await rpc.call<SigInfo[]>("getSignaturesForAddress", [pda, { limit: 1000, before }]);
  signatures.push(...page);
  if (page.length < 1000) break;
  before = page.at(-1)?.signature;
}
await write("signatures.json", signatures);
console.log(`${signatures.length} signatures`);

const uris = new Set<string>();
let noiseSaved = false;
for (const info of [...signatures].reverse()) {
  if (info.err != null) continue;
  const tx = await rpc.call<RawTransaction | null>("getTransaction", [
    info.signature,
    { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" },
  ]);
  if (!tx) {
    console.warn(`unavailable: ${info.signature}`);
    continue;
  }
  const events = decodeMetadataEvents(flattenTransaction(tx), pda);
  const sig8 = info.signature.slice(0, 8);
  if (events.length > 0) {
    await write(`tx-${dateStamp(tx.blockTime)}-${sig8}.json`, tx);
    for (const e of events) {
      console.log(`${dateStamp(tx.blockTime)} ${e.ixPath} ${e.kind} ${e.data?.uri ?? ""}`);
      if (e.data?.uri) uris.add(e.data.uri);
    }
  } else if (!noiseSaved) {
    await write(`tx-noise-${sig8}.json`, tx);
    noiseSaved = true;
  }
}

const account = await rpc.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [
  pda,
  { encoding: "base64", commitment: "finalized" },
]);
await write("account.json", account);

for (const uri of uris) {
  const { key } = normalizeUri(uri);
  const name = key.startsWith("ar:") ? key.slice(3) : encodeURIComponent(key);
  for (const url of gatewayUrls(uri)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      await write(`json-${name}.json`, await res.json());
      break;
    } catch {}
  }
}
console.log("done");

function dateStamp(blockTime: number | null): string {
  return blockTime ? new Date(blockTime * 1000).toISOString().slice(0, 10).replaceAll("-", "") : "unknown";
}

async function write(name: string, value: unknown): Promise<void> {
  await Bun.write(`${OUT}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
}
