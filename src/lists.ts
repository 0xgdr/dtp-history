import { DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT, TRAITS } from "./constants.ts";
import { EXALTED, isEmptyExaltedStat } from "./exalted.ts";
import type { DasAsset, PandaIndex } from "./index-lookup.ts";
import { readTraits } from "./traits.ts";

// The Pandas behind the home page's grids, built alongside the index from the same DAS pages
// (scripts/build-index.ts). "Un-exalted" are the Pandas whose exalted stat now reads "None";
// "unverified" those in neither DTP collection as verified (e.g. #5642); "lost" those whose
// metadata or art still points at Shadow Drive, which is gone.
export type ListKind = "exalted" | "unexalted" | "unverified" | "lost" | "immortal" | "burned";
export const LIST_KINDS: ListKind[] = ["exalted", "unexalted", "unverified", "lost", "immortal", "burned"];

export const LOST_HOST = "shdw-drive.genesysgo.net";

export type ListEntry = {
  n: number;
  mint: string;
  image: string | null;
  burned: boolean;
  // For an exalted Panda, its EXALTED_STAT value (e.g. "TELL_ME_A_JOKE: Mint Date").
  stat?: string;
  // For an unverified or lost Panda, what's wrong (e.g. "In the Immortal collection, unverified").
  note?: string;
  // When `image` is on Shadow Drive (gone): the last art its history can still read, and when.
  lastArt?: { image: string; at: string };
  // True when all six traits match the mint (data/mint-traits.json), false when any differs;
  // absent when either side can't be read. Says nothing about the art (exalting changed it).
  original?: boolean;
};

// Mint-day traits by Panda number, from data/mint-traits.json.
export type MintTraitsByNumber = Record<string, { traits: Record<string, string> } | { error: string }>;

export type PandaLists = { generatedAt: string } & Record<ListKind, ListEntry[]>;

// Only the mint the index chose for each number counts, so a copycat with a Panda's name never
// lands in a grid. Exalted is read from current traits, Immortal from a verified Immortal collection.
// DAS reports only verified collections, so `collections` gives, for each Panda in neither DTP
// collection, the collection key its metadata account holds (null: none).
export function buildLists(
  assets: DasAsset[],
  index: PandaIndex,
  collections: Map<string, string | null> = new Map(),
  mintTraits: MintTraitsByNumber = {},
): PandaLists {
  const numberOf = new Map<string, number>();
  for (const [n, mint] of Object.entries(index.pandas)) numberOf.set(mint, Number(n));
  for (const [n, mint] of Object.entries(index.burned)) numberOf.set(mint, Number(n));

  const lists: PandaLists = {
    generatedAt: index.generatedAt,
    exalted: [],
    unexalted: [],
    unverified: [],
    lost: [],
    immortal: [],
    burned: [],
  };
  const seen = new Set<string>();
  for (const asset of assets) {
    const n = numberOf.get(asset.id);
    if (n === undefined || seen.has(asset.id)) continue;
    seen.add(asset.id);
    const image = asset.content?.links?.image;
    const entry: ListEntry = {
      n,
      mint: asset.id,
      image: image && /^https?:\/\//.test(image) ? image : null,
      burned: index.burned[n] === asset.id,
    };
    // DAS's copy of a Panda whose metadata is on Shadow Drive is stale, so compare only readable ones.
    const original = hostOf(asset.content?.json_uri) === LOST_HOST ? undefined : sameTraits(mintTraits[n], asset);
    if (original !== undefined) entry.original = original;
    const stat = asset.content?.metadata?.attributes?.find((a) => a.trait_type === EXALTED)?.value;
    if (stat !== undefined) {
      if (isEmptyExaltedStat(String(stat))) lists.unexalted.push(entry);
      else lists.exalted.push({ ...entry, stat: String(stat) });
    }
    const inCollection = (key: string) => asset.grouping?.some((g) => g.group_key === "collection" && g.group_value === key);
    if (inCollection(DTP_IMMORTAL_COLLECTION_MINT)) lists.immortal.push(entry);
    if (!inCollection(DTP_COLLECTION_MINT) && !inCollection(DTP_IMMORTAL_COLLECTION_MINT)) {
      lists.unverified.push({ ...entry, note: collectionNote(collections.get(asset.id)) });
    }
    const lostJson = hostOf(asset.content?.json_uri) === LOST_HOST;
    const lostArt = hostOf(image) === LOST_HOST;
    if (lostJson || lostArt) {
      lists.lost.push({ ...entry, note: lostJson && lostArt ? "Metadata and art" : lostJson ? "Metadata" : "Art" });
    }
    if (entry.burned) lists.burned.push(entry);
  }
  for (const kind of LIST_KINDS) lists[kind].sort((a, b) => a.n - b.n);
  return lists;
}

function collectionNote(key: string | null | undefined): string {
  if (key === DTP_IMMORTAL_COLLECTION_MINT) return "In the Immortal collection, unverified";
  if (key === DTP_COLLECTION_MINT) return "In the collection, unverified";
  return key ? "In another collection" : "In no collection";
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function sameTraits(mint: MintTraitsByNumber[string] | undefined, asset: DasAsset): boolean | undefined {
  if (!mint || "error" in mint || !TRAITS.some((t) => t in mint.traits)) return undefined;
  const attributes = asset.content?.metadata?.attributes;
  if (!attributes?.length) return undefined;
  const now = readTraits({ attributes }).values;
  return TRAITS.every((t) => (mint.traits[t] ?? null) === (now.get(t) ?? null));
}
