import { DTP_COLLECTION_MINT, DTP_CREATORS, DTP_IMMORTAL_COLLECTION_MINT } from "./constants.ts";
import type { Cache } from "./cache.ts";
import { decodeMetadataAccount, type MetadataAccount } from "./decode/metadata-account.ts";
import { decodeMetadataEvents, type MetadataEvent } from "./decode/metadata-ix.ts";
import { exaltedVerdict } from "./exalted.ts";
import { diffChain, diffJson, type Change, type ChainState } from "./diff.ts";
import { pandaNumber } from "./index-lookup.ts";
import type { Fetcher } from "./json-fetch.ts";
import { metadataPda } from "./pda.ts";
import type { Rpc } from "./rpc.ts";
import { imageOf, type Json } from "./traits.ts";
import { flattenTransaction, type RawTransaction } from "./tx.ts";
import { displayUrl, normalizeUri } from "./uri.ts";
import { compareImages, verdict, type ImageCheck, type Verdict, type VerdictChange } from "./verdict.ts";

// How far a build has got, for the page to show on long lookups.
export type BuildProgress = { phase: "signatures" | "transactions" | "metadata"; done: number; total: number | null };

export type Deps = {
  rpc: Rpc;
  fetcher: Fetcher;
  cache: Cache;
  now?: () => Date;
  onProgress?: (progress: BuildProgress) => void;
};

export type SigInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };

export type Step = {
  index: number;
  kind: string;
  sig: string | null;
  ixPath: string | null;
  slot: number | null;
  blockTime: number | null;
  dateUtc: string | null;
  authority: string | null;
  txSigners: string[];
  uri: string | null;
  uriKey: string | null;
  json: Json | null;
  jsonError: string | null;
  image: string | null;
  diff: Change[];
  // When metadata before this step couldn't be fetched (e.g. a host that's gone), this step's JSON
  // diff is against the last readable metadata, from this time. The change happened somewhere in
  // between, and the exact update can't be known.
  gapSince: number | null;
  state: ChainState;
};

// A change to which collection the Panda is in: verified into one, unverified from one, or the
// collection field set (always unverified) or cleared by an update.
export type CollectionEvent = {
  sig: string;
  blockTime: number | null;
  dateUtc: string | null;
  action: "verified" | "unverified" | "set" | "cleared";
  collection: string | null;
};

// The original drop (November 2021 onwards) or the Immortal Pandas (minted June 2023, in their own
// collection).
export type Series = "Original" | "Immortal";

export type HistoryResult = {
  number: number | null;
  series: Series;
  mint: string;
  metadataPda: string;
  burned: boolean;
  verdict: Verdict;
  // Set when the verdict is "Exalted": when the exalt changed the art.
  exaltedAt: number | null;
  verdictChanges: VerdictChange[];
  imageCheck: ImageCheck;
  changedInHistory: boolean;
  warnings: string[];
  historyIncomplete: boolean;
  baselineUncertain: boolean;
  original: { jsonUri: string | null; image: string | null };
  current: { jsonUri: string | null; image: string | null };
  steps: Step[];
  collectionEvents: CollectionEvent[];
  otherMetadataIx: { sig: string; ixPath: string; kind: string; dateUtc: string | null; hex?: string }[];
  unavailableSignatures: string[];
  signaturesScanned: number;
  cachedAt: string;
};

// Bump when the shape or meaning of HistoryResult changes, so cached histories are rebuilt
// (cheaply: transactions and JSON stay cached) instead of being served with stale verdicts.
const HISTORY_VERSION = 4;

type CachedHistory = { version?: number; newestSig: string; signatures: SigInfo[]; result: HistoryResult };

const STATE_KINDS = /^(CreateMetadataAccount|UpdateMetadataAccount|Update)/;

const EMPTY_STATE: ChainState = {
  name: null,
  symbol: null,
  uri: null,
  sellerFeeBasisPoints: null,
  creators: null,
  updateAuthority: null,
  primarySaleHappened: null,
  isMutable: null,
  collection: null,
};

// The last finished history for a mint, without touching the RPC.
export async function readCachedHistory(mint: string, cache: Cache): Promise<HistoryResult | null> {
  const cached = await cache.get<CachedHistory>("history", mint);
  return cached?.version === HISTORY_VERSION ? cached.result : null;
}

export async function buildHistory(mint: string, deps: Deps): Promise<HistoryResult> {
  const { rpc, fetcher, cache } = deps;
  const pda = await metadataPda(mint);

  // 1. Signatures, reusing the cached list when nothing new has happened.
  const cached = await cache.get<CachedHistory>("history", mint);
  const head = await rpc.call<SigInfo[]>("getSignaturesForAddress", [pda, { limit: 1 }]);
  if (cached && cached.version === HISTORY_VERSION && head[0]?.signature === cached.newestSig) return cached.result;
  const report = deps.onProgress ?? (() => {});
  const fresh = await fetchSignatures(rpc, pda, cached?.newestSig, (n) =>
    report({ phase: "signatures", done: n, total: null }),
  );
  const signatures = [...fresh, ...(cached?.signatures ?? [])];

  // 2. Transactions, oldest first. Failed txs never changed anything.
  const ordered = signatures.filter((s) => s.err == null).reverse();
  const unavailable: string[] = [];
  let fetched = 0;
  report({ phase: "transactions", done: 0, total: ordered.length });
  const txs = await Promise.all(
    ordered.map(async (s) => {
      const tx = await getTransaction(rpc, cache, s.signature);
      if (!tx) unavailable.push(s.signature);
      report({ phase: "transactions", done: ++fetched, total: ordered.length });
      return tx;
    }),
  );

  // 3. Decode this PDA's Token Metadata instructions.
  const events: MetadataEvent[] = [];
  for (const tx of txs) {
    if (tx && tx.meta?.err == null) events.push(...decodeMetadataEvents(flattenTransaction(tx), pda));
  }
  const stateEvents = events.filter((e) => STATE_KINDS.test(e.kind));
  const otherEvents = events.filter((e) => !STATE_KINDS.test(e.kind) && !e.collectionChange);

  // 4. Current account state.
  const accountInfo = await rpc.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    pda,
    { encoding: "base64", commitment: "finalized" },
  ]);
  let account: MetadataAccount | null = null;
  const warnings: string[] = [];
  if (accountInfo.value) {
    try {
      account = decodeMetadataAccount(Buffer.from(accountInfo.value.data[0], "base64"));
    } catch (err) {
      warnings.push(`metadata account could not be decoded: ${err instanceof Error ? err.message : err}`);
    }
  }
  const burned = accountInfo.value === null;

  // 5. Fold events into states.
  const baselineUncertain = !stateEvents.some((e) => e.kind.startsWith("Create"));
  let historyIncomplete = unavailable.length > 0;
  const folded: { event: MetadataEvent | null; state: ChainState }[] = [];
  const collectionEvents: CollectionEvent[] = [];
  const collectionEvent = (e: MetadataEvent, action: CollectionEvent["action"], collection: string | null) =>
    collectionEvents.push({ sig: e.sig, blockTime: e.blockTime, dateUtc: dateUtc(e.blockTime), action, collection });
  let state = EMPTY_STATE;
  for (const event of events) {
    // Verifying or unverifying a collection changes the state but isn't an update with metadata,
    // so it isn't a step: the page shows it beside them.
    // Re-running a verify on a Panda that is already verified (a sweep of the collection) changes
    // nothing, so only a real change is recorded.
    if (event.collectionChange) {
      if (!Bun.deepEquals(state.collection, event.collectionChange)) {
        state = { ...state, collection: event.collectionChange };
        collectionEvent(event, event.collectionChange.verified ? "verified" : "unverified", event.collectionChange.key);
      }
      continue;
    }
    if (!STATE_KINDS.test(event.kind)) continue;
    const before = state.collection;
    state = applyEvent(state, event);
    if (event.collection !== undefined && !Bun.deepEquals(before, state.collection)) {
      collectionEvent(event, state.collection ? "set" : "cleared", state.collection?.key ?? null);
    }
    folded.push({ event, state });
  }
  if (baselineUncertain) {
    // Without a Create, the history starts at the first event that carried data.
    const firstData = folded.findIndex((f) => f.event?.data);
    if (firstData > 0) folded.splice(0, firstData);
  }

  if (account) {
    const lastUri = folded.at(-1)?.state.uri ?? null;
    const accountKey = normalizeUri(account.data.uri).key;
    if (lastUri === null || normalizeUri(lastUri).key !== accountKey) {
      historyIncomplete = true;
      folded.push({ event: null, state: stateFromAccount(account) });
    }
  }

  // 6. JSON for each distinct URI, then image checks.
  const uris = [...new Set(folded.map((f) => f.state.uri).filter((u): u is string => u !== null))];
  const jsonByKey = new Map<string, { json: Json | null; error: string | null }>();
  let jsonDone = 0;
  report({ phase: "metadata", done: 0, total: uris.length });
  await Promise.all(
    uris.map(async (uri) => {
      jsonByKey.set(normalizeUri(uri).key, await fetcher.json(uri));
      report({ phase: "metadata", done: ++jsonDone, total: uris.length });
    }),
  );

  const steps: Step[] = [];
  // The last step whose metadata could be fetched. JSON diffs compare against it, so a change made
  // while the metadata was unreadable still shows up, at the first readable step after the gap.
  let lastReadable: Step | null = null;
  for (const [i, { event, state: s }] of folded.entries()) {
    const uriKey = s.uri === null ? null : normalizeUri(s.uri).key;
    const fetched = uriKey ? jsonByKey.get(uriKey) : undefined;
    const json = fetched?.json ?? null;
    const prev = steps.at(-1);
    let diff = diffChain(prev?.state ?? null, s);
    // A collection verified or unverified since the last step is a collection event, not this update.
    if (event && event.collection === undefined) diff = diff.filter((c) => c.path !== "collection");
    let gapSince: number | null = null;
    if (json && lastReadable && lastReadable.uriKey !== uriKey) {
      const imageCheck = await compareImages(fetcher, imageOf(lastReadable.json), imageOf(json));
      diff = [...diff, ...diffJson(lastReadable.json, json, imageCheck)];
      if (prev && prev !== lastReadable) gapSince = lastReadable.blockTime;
    }
    const image = imageOf(json);
    steps.push({
      index: i,
      kind: event?.kind ?? "current (source: account)",
      sig: event?.sig ?? null,
      ixPath: event?.ixPath ?? null,
      slot: event?.slot ?? null,
      blockTime: event?.blockTime ?? null,
      dateUtc: dateUtc(event?.blockTime ?? null),
      authority: event?.authority ?? null,
      txSigners: event?.txSigners ?? [],
      uri: s.uri,
      uriKey,
      json,
      jsonError: s.uri === null ? "no URI" : (fetched?.error ?? null),
      image: image ? displayUrl(normalizeUri(image).key) : null,
      diff,
      gapSince,
      state: s,
    });
    if (json) lastReadable = steps.at(-1)!;
  }

  // 7. Verdict: mint-time JSON vs current JSON only.
  const first = steps[0] ?? null;
  const last = steps.at(-1) ?? null;
  const mintImage = imageOf(first?.json ?? null);
  const imageCheck = await compareImages(fetcher, mintImage, imageOf(last?.json ?? null));
  const result = verdict(first?.json ?? null, last?.json ?? null, imageCheck);

  let changedInHistory = false;
  if (result.verdict === "Original") {
    for (const step of steps.slice(1, -1)) {
      if (step.uriKey === first?.uriKey) continue;
      const check = await compareImages(fetcher, mintImage, imageOf(step.json));
      if (verdict(first?.json ?? null, step.json, check).verdict === "Traits/art changed") changedInHistory = true;
    }
  }

  // Being exalted changed the background art, so that alone isn't a swap.
  const exalt = result.verdict === "Traits/art changed" ? exaltedVerdict(steps, result.changes) : null;
  const finalVerdict: Verdict = exalt?.exalted ? "Exalted" : result.verdict;

  warnings.push(...result.warnings);
  if (burned) warnings.push("metadata account does not exist: the Panda is burned or closed");
  const verifiedIn = account?.collection?.verified ? account.collection.key : null;
  if (account && verifiedIn !== DTP_COLLECTION_MINT && verifiedIn !== DTP_IMMORTAL_COLLECTION_MINT) {
    const byCreator = account.data.creators?.some((c) => c.verified && (DTP_CREATORS as readonly string[]).includes(c.address));
    warnings.push(
      byCreator
        ? "its collection isn't verified, but a DTP candy machine creator is"
        : "not a verified Degenerate Trash Panda (collection mismatch)",
    );
  }
  // A burned Panda has no account, so go by its history too.
  const immortal =
    verifiedIn === DTP_IMMORTAL_COLLECTION_MINT ||
    (burned && collectionEvents.some((e) => e.action === "verified" && e.collection === DTP_IMMORTAL_COLLECTION_MINT));
  if (baselineUncertain) warnings.push("no Create instruction found: the earliest decoded data is used as the baseline");
  if (historyIncomplete) warnings.push("history is incomplete: some transactions were unavailable or the account URI was not reached");
  const undecodable = otherEvents.filter((e) => e.kind === "Undecodable").length;
  if (undecodable) warnings.push(`${undecodable} Token Metadata instruction(s) could not be decoded`);

  const name = account?.data.name ?? last?.state.name ?? null;
  const history: HistoryResult = {
    number: pandaNumber(name),
    series: immortal ? "Immortal" : "Original",
    mint,
    metadataPda: pda,
    burned,
    verdict: finalVerdict,
    exaltedAt: exalt?.exaltedAt ?? null,
    verdictChanges: result.changes,
    imageCheck,
    changedInHistory,
    warnings,
    historyIncomplete,
    baselineUncertain,
    original: { jsonUri: first?.uri ?? null, image: first?.image ?? null },
    current: { jsonUri: last?.uri ?? null, image: last?.image ?? null },
    steps,
    collectionEvents,
    otherMetadataIx: otherEvents.map((e) => ({
      sig: e.sig,
      ixPath: e.ixPath,
      kind: e.kind,
      dateUtc: dateUtc(e.blockTime),
      ...(e.hex ? { hex: e.hex } : {}),
    })),
    unavailableSignatures: unavailable,
    signaturesScanned: signatures.length,
    cachedAt: (deps.now?.() ?? new Date()).toISOString(),
  };

  // An incomplete history may fill in later (a pruned tx comes back), so don't pin it.
  const newestSig = signatures[0]?.signature;
  if (newestSig && unavailable.length === 0) {
    await cache.set("history", mint, { version: HISTORY_VERSION, newestSig, signatures, result: history } satisfies CachedHistory);
  }
  return history;
}

// Pages newest to oldest until a short page, or until `stopAt` (the newest cached signature).
async function fetchSignatures(
  rpc: Rpc,
  pda: string,
  stopAt: string | undefined,
  onPage: (count: number) => void,
): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  for (let before: string | undefined; ; ) {
    const page = await rpc.call<SigInfo[]>("getSignaturesForAddress", [pda, { limit: 1000, before }]);
    const stop = stopAt ? page.findIndex((s) => s.signature === stopAt) : -1;
    if (stop >= 0) return [...out, ...page.slice(0, stop)];
    out.push(...page);
    onPage(out.length);
    if (page.length < 1000) return out;
    before = page.at(-1)?.signature;
  }
}

async function getTransaction(rpc: Rpc, cache: Deps["cache"], sig: string): Promise<RawTransaction | null> {
  const cached = await cache.get<RawTransaction>("tx", sig);
  if (cached) return cached;
  const params = [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const tx = await rpc.call<RawTransaction | null>("getTransaction", params);
    if (tx) {
      await cache.set("tx", sig, tx);
      return tx;
    }
  }
  return null;
}

function applyEvent(prev: ChainState, e: MetadataEvent): ChainState {
  const next = { ...prev };
  if (e.kind.startsWith("Create")) {
    next.updateAuthority = e.authority;
    next.primarySaleHappened = false;
    next.collection = e.collection ?? null;
  }
  if (e.data) {
    next.name = e.data.name;
    next.symbol = e.data.symbol;
    next.uri = e.data.uri;
    next.sellerFeeBasisPoints = e.data.sellerFeeBasisPoints;
    next.creators = e.data.creators;
  }
  if (e.collection !== undefined && !e.kind.startsWith("Create")) next.collection = e.collection;
  if (e.updateAuthority !== undefined) next.updateAuthority = e.updateAuthority;
  if (e.primarySaleHappened !== undefined) next.primarySaleHappened = e.primarySaleHappened;
  if (e.isMutable !== undefined) next.isMutable = e.isMutable;
  return next;
}

function stateFromAccount(a: MetadataAccount): ChainState {
  return {
    ...a.data,
    updateAuthority: a.updateAuthority,
    primarySaleHappened: a.primarySaleHappened,
    isMutable: a.isMutable,
    collection: a.collection,
  };
}

function dateUtc(blockTime: number | null): string | null {
  return blockTime === null ? null : new Date(blockTime * 1000).toISOString().slice(0, 10);
}
