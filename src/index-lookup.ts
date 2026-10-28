import { PANDA_NAME_RE } from "./constants.ts";

export type PandaIndex = {
  generatedAt: string;
  collection: string;
  creators: string[];
  count: number;
  pandas: Record<string, string>;
  duplicates: Record<string, string[]>;
  burned: Record<string, string>;
  missing: number[];
  unparsed: { mint: string; name: string }[];
};

export type Input = { type: "number"; n: number } | { type: "mint"; mint: string } | { type: "invalid" };

export type Resolution =
  | { kind: "found"; mint: string }
  | { kind: "burned"; mint: string }
  | { kind: "duplicate"; candidates: string[] }
  | { kind: "missing" }
  | { kind: "unknown" };

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Accepts "6872", "#6872", " 6872 ", "006872" or a base58 mint address.
export function parseInput(raw: string): Input {
  const s = raw.trim().replace(/^#\s*/, "");
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? { type: "number", n } : { type: "invalid" };
  }
  if (BASE58_RE.test(s)) return { type: "mint", mint: s };
  return { type: "invalid" };
}

export function pandaNumber(name: string | null | undefined): number | null {
  const match = name?.replace(/\0+$/, "").trim().match(PANDA_NAME_RE);
  return match ? Number(match[1]) : null;
}

export function resolve(index: PandaIndex, n: number): Resolution {
  const key = String(n);
  const mint = index.pandas[key];
  if (mint) return { kind: "found", mint };
  const dupes = index.duplicates[key];
  if (dupes) return { kind: "duplicate", candidates: dupes };
  const burned = index.burned[key];
  if (burned) return { kind: "burned", mint: burned };
  if (index.missing.includes(n)) return { kind: "missing" };
  return { kind: "unknown" };
}

// --- Building the index from DAS `getAssetsByGroup` pages (see scripts/build-index.ts). ---

export type DasAsset = {
  id: string;
  burnt?: boolean;
  content?: { metadata?: { name?: string } };
  grouping?: { group_key: string; group_value: string }[];
  creators?: { address: string; verified: boolean }[];
};

// An asset belongs if it is in the verified collection or carries a verified DTP creator.
// Pass the pages of `getAssetsByGroup`, `getAssetsByCreator` and burnt `searchAssets`; overlap is deduplicated.
export function buildIndex(
  assets: DasAsset[],
  collection: string,
  creators: readonly string[],
  generatedAt: string,
): PandaIndex {
  const byNumber = new Map<number, string[]>();
  const burned: Record<string, string> = {};
  const unparsed: { mint: string; name: string }[] = [];

  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    const inCollection = asset.grouping?.some((g) => g.group_key === "collection" && g.group_value === collection);
    const byCreator = asset.creators?.some((c) => c.verified && creators.includes(c.address));
    if (!inCollection && !byCreator) continue;
    const name = asset.content?.metadata?.name ?? "";
    const n = pandaNumber(name);
    if (n === null) {
      unparsed.push({ mint: asset.id, name });
      continue;
    }
    if (asset.burnt) {
      burned[n] = asset.id;
      continue;
    }
    byNumber.set(n, [...(byNumber.get(n) ?? []), asset.id]);
  }

  const pandas: Record<string, string> = {};
  const duplicates: Record<string, string[]> = {};
  for (const [n, mints] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    const unique = [...new Set(mints)];
    if (unique.length > 1) duplicates[n] = unique;
    else pandas[n] = unique[0]!;
  }

  const highest = Math.max(0, ...byNumber.keys(), ...Object.keys(burned).map(Number));
  const missing: number[] = [];
  for (let n = 1; n <= highest; n++) {
    if (!byNumber.has(n) && !(n in burned)) missing.push(n);
  }

  return {
    generatedAt,
    collection,
    creators: [...creators],
    count: Object.keys(pandas).length,
    pandas,
    duplicates,
    burned,
    missing,
    unparsed,
  };
}

// Numbers the previous index had a mint for (live or burned) that `next` has lost. DAS drops a Panda
// from its listings when the token alone is burned, so the build looks these up by id.
export function lostMints(previous: PandaIndex, next: PandaIndex): { n: number; mint: string }[] {
  const lost: { n: number; mint: string }[] = [];
  for (const n of next.missing) {
    const mint = previous.pandas[n] ?? previous.burned[n];
    if (mint) lost.push({ n, mint });
  }
  return lost;
}
