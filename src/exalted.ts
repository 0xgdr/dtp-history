import type { Change } from "./diff.ts";
import { readTraits, type Json } from "./traits.ts";

// Exalted Pandas carry an EXALTED_STAT attribute ("TELL_ME_A_JOKE: Mint Date"). Early on the stat
// was its own trait ("TELL_ME_A_JOKE": "Mint Date") before moving into EXALTED_STAT, and being
// exalted also changed the Panda's background art.
export const EXALTED = "EXALTED_STAT";

// Nine exalted Pandas were left with "EXALTED_STAT: None" when their traits were swapped in late
// 2022 (#29, #1020, …): the slot stays but they aren't exalted any more.
export function isEmptyExaltedStat(value: string): boolean {
  return /:\s*none$/i.test(value.trim());
}

// Stat names seen in EXALTED_STAT values, so the older one-trait form can be recognised.
export function exaltedNames(jsons: (Json | null)[]): Set<string> {
  const names = new Set<string>();
  for (const json of jsons) {
    const value = readTraits(json).values.get(EXALTED);
    // An emptied stat ("EXALTED_STAT: None") names no stat.
    const name = value && !isEmptyExaltedStat(value) ? value.split(":")[0]?.trim().toUpperCase() : undefined;
    if (name) names.add(name);
  }
  return names;
}

export function isExaltedKey(key: string, names: Set<string>): boolean {
  const upper = key.toUpperCase();
  return upper === EXALTED || names.has(upper);
}

// True when this update added an exalted attribute, in either form.
export function addsExalted(diff: Change[], names: Set<string>): boolean {
  return diff.some((c) => c.path.startsWith("attributes.") && c.from === "missing" && isExaltedKey(c.path.slice(11), names));
}

type StepLike = { blockTime: number | null; json: Json | null; diff: Change[] };

// A Panda whose six traits all match the mint and whose only art changes came with being exalted
// gets "Exalted" rather than "Traits/art changed".
export function exaltedVerdict(
  steps: StepLike[],
  changes: { field: string }[],
): { exalted: boolean; exaltedAt: number | null } {
  const no = { exalted: false, exaltedAt: null };
  if (changes.length === 0 || !changes.every((c) => c.field === "image")) return no;
  const names = exaltedNames(steps.map((s) => s.json));
  const artSteps = steps.filter((s) => s.diff.some((c) => c.path === "image" && c.tag === "swap"));
  if (artSteps.length === 0 || !artSteps.every((s) => addsExalted(s.diff, names))) return no;
  return { exalted: true, exaltedAt: artSteps[0]!.blockTime };
}
