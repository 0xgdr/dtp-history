import { TRAITS } from "./constants.ts";
import type { Fetcher } from "./json-fetch.ts";
import { imageOf, readTraits, type Json } from "./traits.ts";
import { normalizeUri } from "./uri.ts";

export type ImageCheck = "same" | "rehosted" | "different" | "unknown";
// "Exalted" is set by history.ts (see exalted.ts); verdict() itself returns the other three.
export type Verdict = "Original" | "Traits/art changed" | "Exalted" | "Unknown";
export type VerdictChange = { field: string; from: string | null; to: string | null };

// Same canonical key: same art. Different keys: compare SHA-256 of the bytes.
export async function compareImages(fetcher: Fetcher, a: string | null, b: string | null): Promise<ImageCheck> {
  if (a === null && b === null) return "same";
  if (a === null || b === null) return "different";
  if (normalizeUri(a).key === normalizeUri(b).key) return "same";
  const [ha, hb] = await Promise.all([fetcher.imageHash(a), fetcher.imageHash(b)]);
  if (ha === null || hb === null) return "unknown";
  return ha === hb ? "rehosted" : "different";
}

// Only the image and the six traits decide the verdict; everything else is cosmetic.
export function verdict(
  mintJson: Json | null,
  currentJson: Json | null,
  imageCheck: ImageCheck,
): { verdict: Verdict; changes: VerdictChange[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!mintJson) return { verdict: "Unknown", changes: [], warnings: ["mint-time JSON could not be fetched"] };
  if (!currentJson) return { verdict: "Unknown", changes: [], warnings: ["current JSON could not be fetched"] };

  const mint = readTraits(mintJson);
  const current = readTraits(currentJson);
  warnings.push(...mint.warnings.map((w) => `mint JSON: ${w}`), ...current.warnings.map((w) => `current JSON: ${w}`));
  if (!TRAITS.some((t) => mint.values.has(t))) {
    return { verdict: "Unknown", changes: [], warnings: [...warnings, "mint JSON has none of the six traits"] };
  }

  const changes: VerdictChange[] = [];
  if (imageCheck === "different") {
    changes.push({ field: "image", from: imageOf(mintJson), to: imageOf(currentJson) });
  }
  for (const trait of TRAITS) {
    const from = mint.values.get(trait) ?? null;
    const to = current.values.get(trait) ?? null;
    if (from !== to) changes.push({ field: trait, from, to });
  }

  if (changes.length > 0) return { verdict: "Traits/art changed", changes, warnings };
  if (imageCheck === "unknown") {
    return { verdict: "Unknown", changes, warnings: [...warnings, "image comparison failed (image fetch error)"] };
  }
  return { verdict: "Original", changes, warnings };
}
