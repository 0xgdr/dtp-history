// Lists every mint the original Candy Machine v1 made, writes them to data/original-mints.json and
// prints the ones the index doesn't have. That's how the Pandas DAS won't list (token burned,
// metadata left behind) were found; they went into data/extra-mints.json.
//
// The machine finished at 14,173 mints in November 2021, so this never needs to run again unless
// the list is lost. It's slow: the machine has about 1.4M signatures (mostly failed bot txs), and
// each of the ~16,000 successful txs it needs is fetched one by one (~50 min on a free Helius plan).
// Progress is kept in .cache/, so an interrupted run picks up where it stopped.
import { createRpc, RpcError } from "../src/rpc.ts";
import { loadConfig } from "../src/config.ts";
import type { PandaIndex } from "../src/index-lookup.ts";

const CANDY_MACHINE = "CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp";
const CANDY_MACHINE_PROGRAM = "cndyAnrLdpjq1Ssp1z8xxDsB8dxe7u4HL5Nxi2K5WXZ";
const REDEEMED = 14_173; // itemsRedeemed on the candy machine account
const ROOT = `${import.meta.dir}/..`;
const SIGS = `${ROOT}/.cache/find-unlisted-sigs.json`;
const STATE = `${ROOT}/.cache/find-unlisted-state.json`;
const OUT = `${ROOT}/data/original-mints.json`;

type Sig = { signature: string; err: unknown; blockTime: number | null };
type Found = { mint: string; sig: string; at: number };
type Tx = {
  blockTime: number;
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[] }[] } };
  meta: { loadedAddresses?: { writable: string[]; readonly: string[] } };
};

if (!Bun.env.RPC_URL) {
  console.error("Set RPC_URL (e.g. Helius).");
  process.exit(1);
}
const config = loadConfig();
const rpc = createRpc(config.rpcUrl, { rps: 6, concurrency: 4 });

// 1. The machine's successful signatures, oldest first. Kept, since listing them takes ~10 min.
let sigs: Sig[];
if (await Bun.file(SIGS).exists()) sigs = await Bun.file(SIGS).json();
else {
  sigs = [];
  for (let before: string | undefined; ; ) {
    const batch = await rpc.call<Sig[]>("getSignaturesForAddress", [CANDY_MACHINE, { limit: 1000, ...(before ? { before } : {}) }]);
    sigs.push(...batch.filter((s) => s.err == null).map(({ signature, err, blockTime }) => ({ signature, err, blockTime })));
    if (batch.length < 1000) break;
    before = batch.at(-1)!.signature;
  }
  sigs.reverse();
  await Bun.write(SIGS, JSON.stringify(sigs));
}
console.log(`${sigs.length} successful txs`);

// The free plan rate-limits in bursts; wait those out rather than lose the run.
async function getTransaction(signature: string): Promise<Tx | null> {
  for (;;) {
    try {
      return await rpc.call<Tx | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    } catch (err) {
      if (err instanceof RpcError && err.message.includes("status 429")) await Bun.sleep(30_000);
      else if (err instanceof RpcError && err.message.includes("-32015")) return null; // a newer tx version: not a 2021 mint
      else throw err;
    }
  }
}

// 2. Read them in order until every redeemed item has turned up. MintNft's accounts are
// [config, candyMachine, payer, wallet, metadata, mint, ...].
const saved = (await Bun.file(STATE).exists()) ? await Bun.file(STATE).json() : { next: 0, found: [] };
const found = new Map<string, Found>((saved.found as Found[]).map((f) => [f.mint, f]));
const BATCH = 48;
for (let i = saved.next; i < sigs.length && found.size < REDEEMED; i += BATCH) {
  await Promise.all(
    sigs.slice(i, i + BATCH).map(async ({ signature }) => {
      const tx = await getTransaction(signature);
      if (!tx) return;
      const { accountKeys, instructions } = tx.transaction.message;
      const keys = [...accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      for (const ix of instructions) {
        if (keys[ix.programIdIndex] !== CANDY_MACHINE_PROGRAM || keys[ix.accounts[1]!] !== CANDY_MACHINE) continue;
        const mint = ix.accounts.length >= 15 ? keys[ix.accounts[5]!] : undefined;
        if (mint) found.set(mint, { mint, sig: signature, at: tx.blockTime });
      }
    }),
  );
  await Bun.write(STATE, JSON.stringify({ next: i + BATCH, found: [...found.values()] }));
  if ((i / BATCH) % 40 === 0) console.log(`read ${i + BATCH} of ${sigs.length}, ${found.size} mints`);
}

// 3. Write the list in mint order, and report what the index doesn't have.
const mints = [...found.values()].sort((a, b) => a.at - b.at || a.sig.localeCompare(b.sig)).map((f) => f.mint);
await Bun.write(
  OUT,
  `${JSON.stringify({
    candyMachine: CANDY_MACHINE,
    note: "Every mint the original Candy Machine v1 made (22–24 Nov 2021), in mint order. Built by scripts/find-unlisted-mints.ts.",
    count: mints.length,
    mints,
  })}\n`,
);
const index = (await Bun.file(`${ROOT}/data/panda-index.json`).json()) as PandaIndex;
const indexed = new Set([...Object.values(index.pandas), ...Object.values(index.burned), ...Object.values(index.duplicates).flat()]);
const unlisted = mints.filter((m) => !indexed.has(m));
console.log(`${mints.length} mints, ${unlisted.length} not in the index`);
for (const mint of unlisted) console.log(`  ${mint}: add to data/extra-mints.json if it's a Panda`);
