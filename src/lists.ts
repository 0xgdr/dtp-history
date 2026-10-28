import { DTP_IMMORTAL_COLLECTION_MINT } from "./constants.ts";
import { EXALTED, isEmptyExaltedStat } from "./exalted.ts";
import type { DasAsset, PandaIndex } from "./index-lookup.ts";

// The Pandas behind the home page's Exalted, Immortal and Burned grids, built alongside the index
// from the same DAS pages (scripts/build-index.ts), so they cost no extra calls. "Un-exalted" are
// the Pandas whose exalted stat now reads "None".
export type ListKind = "exalted" | "unexalted" | "immortal" | "burned";
export const LIST_KINDS: ListKind[] = ["exalted", "unexalted", "immortal", "burned"];

export type ListEntry = {
  n: number;
  mint: string;
  image: string | null;
  burned: boolean;
  // For an exalted Panda, its EXALTED_STAT value (e.g. "TELL_ME_A_JOKE: Mint Date").
  stat?: string;
};

export type PandaLists = { generatedAt: string } & Record<ListKind, ListEntry[]>;

// Only the mint the index chose for each number counts, so a copycat with a Panda's name never
// lands in a grid. Exalted is read from current traits, Immortal from a verified Immortal collection.
export function buildLists(assets: DasAsset[], index: PandaIndex): PandaLists {
  const numberOf = new Map<string, number>();
  for (const [n, mint] of Object.entries(index.pandas)) numberOf.set(mint, Number(n));
  for (const [n, mint] of Object.entries(index.burned)) numberOf.set(mint, Number(n));

  const lists: PandaLists = { generatedAt: index.generatedAt, exalted: [], unexalted: [], immortal: [], burned: [] };
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
    const stat = asset.content?.metadata?.attributes?.find((a) => a.trait_type === EXALTED)?.value;
    if (stat !== undefined) {
      if (isEmptyExaltedStat(String(stat))) lists.unexalted.push(entry);
      else lists.exalted.push({ ...entry, stat: String(stat) });
    }
    if (asset.grouping?.some((g) => g.group_key === "collection" && g.group_value === DTP_IMMORTAL_COLLECTION_MINT)) {
      lists.immortal.push(entry);
    }
    if (entry.burned) lists.burned.push(entry);
  }
  for (const kind of LIST_KINDS) lists[kind].sort((a, b) => a.n - b.n);
  return lists;
}
