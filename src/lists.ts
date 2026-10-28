import { DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT } from "./constants.ts";
import { EXALTED, isEmptyExaltedStat } from "./exalted.ts";
import type { DasAsset, PandaIndex } from "./index-lookup.ts";

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
  // True when the Panda was never put through the Boots trait swap: its art is the mint-day file
  // (data/mint-traits.json), or a file uploaded in 2021, when Pandas were exalted and mint-week
  // fixes made (e.g. #12's Body on 23 November 2021). Boots changes only ever show as art uploaded
  // later, during or after the Shadow Drive years (#275's hoodie, first readable in October 2026,
  // with its traits left as minted). An Arweave id always returns the same data, so the file says
  // whether the art changed. Absent when the art or its upload date can't be read.
  original?: boolean;
};

// When each image file was uploaded to Arweave (Unix seconds), by Arweave id, from
// data/art-uploads.json; null when Arweave's index doesn't know it.
export type ArtUploads = Record<string, number | null>;
// Boots-era art starts here: anything uploaded before is the mint, the exalt or a mint-week fix.
export const BOOTS_ERA = Date.UTC(2022, 0, 1) / 1000;

// Mint-day traits and art by Panda number, from data/mint-traits.json.
export type MintTraitsByNumber = Record<string, { traits: Record<string, string>; image?: string | null } | { error: string }>;

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
  artUploads: ArtUploads = {},
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
    const original = hostOf(asset.content?.json_uri) === LOST_HOST ? undefined : neverBoots(mintTraits[n], asset, artUploads);
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

function neverBoots(mint: MintTraitsByNumber[string] | undefined, asset: DasAsset, artUploads: ArtUploads): boolean | undefined {
  const image = asset.content?.links?.image;
  const id = image ? fileId(image) : null;
  if (!mint || "error" in mint || !mint.image || !id) return undefined;
  if (fileId(mint.image) === id) return true;
  const uploadedAt = artUploads[id];
  return uploadedAt == null ? undefined : uploadedAt < BOOTS_ERA;
}

// The Arweave ids of grid Pandas' current art that isn't their mint-day file: the ones whose
// upload date decides `original`.
export function artIdsToDate(assets: DasAsset[], index: PandaIndex, mintTraits: MintTraitsByNumber): string[] {
  const numberOf = new Map([...Object.entries(index.pandas), ...Object.entries(index.burned)].map(([n, mint]) => [mint, n]));
  const ids = new Set<string>();
  for (const asset of assets) {
    const n = numberOf.get(asset.id);
    const mint = n === undefined ? undefined : mintTraits[n];
    const image = asset.content?.links?.image;
    const id = image && hostOf(image) !== LOST_HOST ? fileId(image) : null;
    if (id && mint && !("error" in mint) && mint.image && fileId(mint.image) !== id) ids.add(id);
  }
  return [...ids];
}

// The Arweave id an image URL names, whatever the gateway or query (e.g. ?ext=png).
function fileId(url: string): string | null {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}
