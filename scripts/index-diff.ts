// Compares data/panda-index.json and data/lists.json with the committed ones and prints a Markdown
// summary of what changed, for the scheduled rebuild's PR (.github/workflows/rebuild-index.yml). A
// rebuild that only moved generatedAt is no change. Under GitHub Actions it also sets the step
// output `changed`.
import { $ } from "bun";
import type { PandaIndex } from "../src/index-lookup.ts";

const PATH = "data/panda-index.json";
const before = JSON.parse(await $`git show HEAD:${PATH}`.text()) as PandaIndex;
const after = (await Bun.file(`${import.meta.dir}/../${PATH}`).json()) as PandaIndex;

const status = (index: PandaIndex, n: string) =>
  index.pandas[n] ? `live ${index.pandas[n]}` : index.burned[n] ? `burned ${index.burned[n]}` : index.duplicates[n] ? "duplicate" : "missing";
const numbers = new Set([before, after].flatMap((i) => [...Object.keys(i.pandas), ...Object.keys(i.burned), ...Object.keys(i.duplicates), ...i.missing.map(String)]));
const moved = [...numbers]
  .filter((n) => status(before, n) !== status(after, n))
  .sort((a, b) => Number(a) - Number(b))
  .map((n) => `| #${n} | ${status(before, n)} | ${status(after, n)} |`);

const count = (i: PandaIndex) => ({
  live: i.count,
  burned: Object.keys(i.burned).length,
  duplicates: Object.keys(i.duplicates).length,
  missing: i.missing.length,
  unparsed: i.unparsed.length,
});
const [b, a] = [count(before), count(after)];
// The grids (data/lists.json, once it exists): a Panda can be exalted without the index changing.
type Lists = Record<string, unknown> & { generatedAt?: string };
const LISTS = "data/lists.json";
const listsBefore = (await $`git show HEAD:${LISTS}`.nothrow().quiet()).exitCode === 0 ? (JSON.parse(await $`git show HEAD:${LISTS}`.text()) as Lists) : null;
const listsAfter = (await Bun.file(`${import.meta.dir}/../${LISTS}`).exists()) ? ((await Bun.file(`${import.meta.dir}/../${LISTS}`).json()) as Lists) : null;
const withoutDate = (l: Lists | null) => (l ? JSON.stringify({ ...l, generatedAt: undefined }) : null);
const listSizes = (l: Lists | null) =>
  l ? Object.entries(l).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k} ${(v as unknown[]).length}`).join(", ") : "none";
const listsChanged = withoutDate(listsBefore) !== withoutDate(listsAfter);

const changed = listsChanged || moved.length > 0 || JSON.stringify(b) !== JSON.stringify(a);

const lines = [
  "| | before | after |",
  "|---|---|---|",
  ...Object.keys(a).map((k) => `| ${k} | ${b[k as keyof typeof b]} | ${a[k as keyof typeof a]} |`),
  "",
  moved.length ? `${moved.length} number(s) changed:\n\n| Panda | before | after |\n|---|---|---|\n${moved.join("\n")}` : "No number changed status.",
  "",
  listsChanged ? `Grids changed: ${listSizes(listsBefore)} → ${listSizes(listsAfter)}.` : "Grids unchanged.",
];
console.log(lines.join("\n"));

if (Bun.env.GITHUB_OUTPUT) await $`echo changed=${changed} >> ${Bun.env.GITHUB_OUTPUT}`;
