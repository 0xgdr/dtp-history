import { TRAITS } from "./constants.ts";

export type Json = Record<string, unknown>;

export type TraitMap = {
  // Keyed by trimmed, upper-cased trait_type. Values are trimmed strings.
  values: Map<string, string>;
  // Original trait_type spelling, for display.
  labels: Map<string, string>;
  warnings: string[];
};

export function readTraits(json: Json | null): TraitMap {
  const values = new Map<string, string>();
  const labels = new Map<string, string>();
  const warnings: string[] = [];
  const attributes = json?.attributes;
  if (!Array.isArray(attributes)) return { values, labels, warnings };

  for (const attr of attributes) {
    if (!attr || typeof attr !== "object") continue;
    const { trait_type: type, value } = attr as { trait_type?: unknown; value?: unknown };
    if (type === undefined || type === null) continue;
    const label = String(type).trim();
    const key = label.toUpperCase();
    if (values.has(key)) {
      warnings.push(`duplicate trait_type "${label}": using the first`);
      continue;
    }
    values.set(key, value === undefined || value === null ? "" : String(value).trim());
    labels.set(key, label);
  }
  return { values, labels, warnings };
}

export function isVerdictTrait(key: string): boolean {
  return (TRAITS as readonly string[]).includes(key);
}

export function imageOf(json: Json | null): string | null {
  return typeof json?.image === "string" && json.image.trim() ? json.image.trim() : null;
}
