import type { Collection, Creator } from "./decode/metadata-ix.ts";
import { imageOf, isVerdictTrait, readTraits, type Json } from "./traits.ts";
import { normalizeUri } from "./uri.ts";
import type { ImageCheck } from "./verdict.ts";

export type Change = {
  path: string;
  from: unknown;
  to: unknown;
  tag: "swap" | "cosmetic";
  label?: string;
};

// On-chain metadata after an event has been applied.
export type ChainState = {
  name: string | null;
  symbol: string | null;
  uri: string | null;
  sellerFeeBasisPoints: number | null;
  creators: Creator[] | null;
  updateAuthority: string | null;
  primarySaleHappened: boolean | null;
  isMutable: boolean | null;
  collection: Collection | null;
};

const SCALAR_FIELDS = [
  "name",
  "symbol",
  "sellerFeeBasisPoints",
  "updateAuthority",
  "primarySaleHappened",
  "isMutable",
] as const;

// Chain-field changes are always cosmetic: only the JSON's image and traits count as a swap.
export function diffChain(prev: ChainState | null, next: ChainState): Change[] {
  if (!prev) return [];
  const changes: Change[] = [];
  const cosmetic = (path: string, from: unknown, to: unknown, label?: string) =>
    changes.push({ path, from, to, tag: "cosmetic", ...(label ? { label } : {}) });

  for (const field of SCALAR_FIELDS) {
    if (prev[field] !== next[field]) cosmetic(field, prev[field], next[field]);
  }

  if (prev.uri !== next.uri) {
    const sameContent = prev.uri !== null && next.uri !== null && normalizeUri(prev.uri).key === normalizeUri(next.uri).key;
    cosmetic("uri", prev.uri, next.uri, sameContent ? "URI host move" : undefined);
  }

  const before = new Map((prev.creators ?? []).map((c) => [c.address, c]));
  const after = new Map((next.creators ?? []).map((c) => [c.address, c]));
  for (const [address, c] of before) {
    const n = after.get(address);
    if (!n) cosmetic(`creators.${address}`, c, null, "creator removed");
    else if (n.share !== c.share || n.verified !== c.verified) cosmetic(`creators.${address}`, c, n, "creator changed");
  }
  for (const [address, n] of after) {
    if (!before.has(address)) cosmetic(`creators.${address}`, null, n, "creator added");
  }

  if (!Bun.deepEquals(prev.collection, next.collection)) cosmetic("collection", prev.collection, next.collection);
  return changes;
}

// `imageCheck` compares prev.image with next.image (see compareImages).
export function diffJson(prev: Json | null, next: Json | null, imageCheck: ImageCheck): Change[] {
  if (!prev || !next) return [];
  const changes: Change[] = [];

  const prevImage = imageOf(prev);
  const nextImage = imageOf(next);
  if (prevImage !== nextImage) {
    if (imageCheck === "same") {
      changes.push({ path: "image", from: prevImage, to: nextImage, tag: "cosmetic", label: "image URL host move" });
    } else if (imageCheck === "rehosted") {
      changes.push({ path: "image", from: prevImage, to: nextImage, tag: "cosmetic", label: "image re-hosted" });
    } else {
      const label = imageCheck === "unknown" ? "image changed (bytes not compared)" : undefined;
      changes.push({ path: "image", from: prevImage, to: nextImage, tag: "swap", ...(label ? { label } : {}) });
    }
  }

  const a = readTraits(prev);
  const b = readTraits(next);
  for (const key of new Set([...a.values.keys(), ...b.values.keys()])) {
    const from = a.values.get(key) ?? null;
    const to = b.values.get(key) ?? null;
    if (from === to) continue;
    const label = a.labels.get(key) ?? b.labels.get(key) ?? key;
    changes.push({
      path: `attributes.${isVerdictTrait(key) ? key : label}`,
      from: from ?? "missing",
      to: to ?? "missing",
      tag: isVerdictTrait(key) ? "swap" : "cosmetic",
    });
  }

  // Remaining keys are cosmetic. `properties` is compared per sub-key for readable chips.
  const skip = new Set(["image", "attributes", "properties"]);
  diffObjects(prev, next, "", skip, changes);
  const pp = isObject(prev.properties) ? prev.properties : {};
  const np = isObject(next.properties) ? next.properties : {};
  diffObjects(pp, np, "properties.", new Set(), changes);
  if (isObject(prev.properties) !== isObject(next.properties)) {
    changes.push({ path: "properties", from: prev.properties ?? null, to: next.properties ?? null, tag: "cosmetic" });
  }
  return changes;
}

function diffObjects(a: Json, b: Json, prefix: string, skip: Set<string>, out: Change[]): void {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(key)) continue;
    if (!Bun.deepEquals(a[key], b[key])) {
      out.push({ path: `${prefix}${key}`, from: a[key] ?? null, to: b[key] ?? null, tag: "cosmetic" });
    }
  }
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
