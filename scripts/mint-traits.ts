// Writes data/mint-traits.json: every Panda's six traits, art and date on the day it was minted,
// read from the Create instruction in its metadata account's first transaction and the metadata
// file that instruction points at. Mint-day traits never change, so this runs once; afterwards the
// index build compares them with today's traits to mark grid Pandas as original.
//
// About 3 RPC calls and one Arweave fetch per Panda, so ~3 hours for all 20,000. Progress is saved
// after every batch: re-running carries on, and retries the Pandas that failed.
import { TRAITS } from "../src/constants.ts";
import { loadConfig, redactUrl } from "../src/config.ts";
import { decodeMetadataEvents } from "../src/decode/metadata-ix.ts";
import type { PandaIndex } from "../src/index-lookup.ts";
import { metadataPda } from "../src/pda.ts";
import { createRpc, RpcError } from "../src/rpc.ts";
import { sourcesFor } from "../src/thumb.ts";
import { readTraits, imageOf, type Json } from "../src/traits.ts";
import { flattenTransaction, type RawTransaction } from "../src/tx.ts";

const ROOT = `${import.meta.dir}/..`;
// MINT_TRAITS_OUT and ONLY (e.g. ONLY=6872,55) are for trying it on a few Pandas.
const OUT = Bun.env.MINT_TRAITS_OUT ?? `${ROOT}/data/mint-traits.json`;
const ONLY = Bun.env.ONLY ? new Set(Bun.env.ONLY.split(",").map(Number)) : null;
// Workers each take the next Panda as soon as they finish one, so a slow Arweave fetch holds up
// only itself. The RPC client caps the request rate; this caps how many Pandas are in flight.
const WORKERS = Number(Bun.env.WORKERS ?? 48);

export type MintTraits =
  | { at: string; uri: string; image: string | null; traits: Record<string, string> }
  | { at: string | null; uri: string | null; error: string };

type Sig = { signature: string; err: unknown; blockTime: number | null };

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL (e.g. Helius).");
  process.exit(1);
}
const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: config.rpcRps, concurrency: config.rpcConcurrency });
console.log(`Reading mint-day metadata via ${redactUrl(config.rpcUrl)}`);

// The free plan rate-limits in bursts; wait those out rather than lose the run.
async function call<T>(method: string, params: unknown): Promise<T> {
  for (;;) {
    try {
      return await rpc.call<T>(method, params);
    } catch (err) {
      if (err instanceof RpcError && err.message.includes("status 429")) await Bun.sleep(30_000);
      else throw err;
    }
  }
}

// Oldest signatures first: page back to the account's first transaction.
async function oldestSignatures(address: string): Promise<Sig[]> {
  let page: Sig[] = [];
  for (let before: string | undefined; ; ) {
    const batch = await call<Sig[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (batch.length > 0) page = batch;
    if (batch.length < 1000) break;
    before = batch.at(-1)!.signature;
  }
  return page.filter((s) => s.err == null).reverse();
}

// Helius's archived copy of some early-2022 transactions has no inner instructions or logs (e.g.
// #14381's Candy Machine v2 mint), which hides the Create inside them. Solana's public RPC has them.
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
async function getTransaction(signature: string): Promise<RawTransaction | null> {
  const tx = await call<RawTransaction | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  if (!tx || tx.meta?.innerInstructions) return tx;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(PUBLIC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }] }),
    });
    if (res.ok) return ((await res.json()) as { result: RawTransaction | null }).result ?? tx;
    await Bun.sleep(5_000 * 2 ** attempt); // the public RPC rate-limits hard
  }
  return tx;
}

// Arweave and ArDrive both serve any Arweave id; try the other when one fails (see src/thumb.ts).
async function fetchJson(uri: string): Promise<Json> {
  const urls = (() => {
    try {
      return sourcesFor(uri);
    } catch {
      return [uri];
    }
  })();
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      return (await res.json()) as Json;
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(failures.join("; "));
}

async function mintTraits(mint: string): Promise<MintTraits> {
  const pda = await metadataPda(mint);
  const sigs = await oldestSignatures(pda);
  // The Create is in the first transaction; look at a few in case the first did something else.
  for (const sig of sigs.slice(0, 5)) {
    const tx = await getTransaction(sig.signature);
    if (!tx) continue;
    const create = decodeMetadataEvents(flattenTransaction(tx), pda).find((e) => e.kind.startsWith("Create"));
    if (!create?.data) continue;
    return readMetadata(new Date((sig.blockTime ?? 0) * 1000).toISOString(), create.data.uri);
  }
  return { at: null, uri: null, error: sigs.length ? "no Create instruction in its first transactions" : "no transactions" };
}

// The traits live in the metadata file on Arweave, not on chain, so this part can fail on its own
// when Arweave is down; the URI and date found on chain are kept for a retry.
async function readMetadata(at: string, uri: string): Promise<MintTraits> {
  try {
    const json = await fetchJson(uri);
    const values = readTraits(json).values;
    const traits = Object.fromEntries(TRAITS.flatMap((t) => (values.has(t) ? [[t, values.get(t)!]] : [])));
    return { at, uri, image: imageOf(json), traits };
  } catch (err) {
    return { at, uri, error: `metadata unreadable: ${err instanceof Error ? err.message : err}` };
  }
}

const index = (await Bun.file(`${ROOT}/data/panda-index.json`).json()) as PandaIndex;
const pandas = [...Object.entries(index.pandas), ...Object.entries(index.burned)]
  .map(([n, mint]) => ({ n: Number(n), mint }))
  .filter((p) => !ONLY || ONLY.has(p.n))
  .sort((a, b) => a.n - b.n);

const done: Record<string, MintTraits> = (await Bun.file(OUT).exists()) ? ((await Bun.file(OUT).json()) as { pandas: Record<string, MintTraits> }).pandas : {};
const todo = pandas.filter((p) => !done[p.n] || "error" in done[p.n]!);
console.log(`${pandas.length} Pandas, ${pandas.length - todo.length} done, ${todo.length} to go`);

// One Panda per line, so diffs and partial files stay readable.
async function save(): Promise<void> {
  const keys = Object.keys(done).sort((a, b) => Number(a) - Number(b));
  const lines = keys.map((n) => `    ${JSON.stringify(n)}: ${JSON.stringify(done[n])}`);
  await Bun.write(OUT, `{\n  "pandas": {\n${lines.join(",\n")}\n  }\n}\n`);
}

const started = Date.now();
let next = 0;
let finished = 0;
let saving: Promise<void> = Promise.resolve();
async function worker(): Promise<void> {
  while (next < todo.length) {
    const { n, mint } = todo[next++]!;
    try {
      // A retry whose URI is already known only needs the metadata file again.
      const known = done[n];
      done[n] = known && "error" in known && known.uri && known.at ? await readMetadata(known.at, known.uri) : await mintTraits(mint);
    } catch (err) {
      done[n] = { at: null, uri: null, error: err instanceof Error ? err.message : String(err) };
    }
    // Save (one write at a time) and report every 100 Pandas.
    if (++finished % 100 === 0) {
      saving = saving.then(save);
      await saving;
      const perPanda = (Date.now() - started) / finished;
      console.log(`${finished} of ${todo.length}, ~${Math.round(((todo.length - finished) * perPanda) / 60_000)} min left`);
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
await saving;
await save();
const failed = Object.entries(done).filter(([, t]) => "error" in t);
console.log(`done: ${Object.keys(done).length} Pandas, ${failed.length} failed`);
for (const [n, t] of failed.slice(0, 20)) console.log(`  #${n}: ${"error" in t ? t.error : ""}`);
