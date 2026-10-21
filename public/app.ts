// Type-only imports are erased by Bun's bundler, so the page shares the API's types for free.
// traits.ts is tiny and dependency-free, so the page reuses the server's trait matching.
import { TRAITS } from "../src/constants.ts";
import type { Change } from "../src/diff.ts";
import { addsExalted, EXALTED, exaltedNames } from "../src/exalted.ts";
import type { HistoryResult, Step } from "../src/history.ts";
import { readTraits } from "../src/traits.ts";

type ApiError = { error: string; detail: string; candidates?: string[] };

const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#q")!;
const result = document.querySelector<HTMLElement>("#result")!;

let inflight: AbortController | null = null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  const url = new URL(location.href);
  url.searchParams.set("n", q);
  history.pushState(null, "", url);
  load(q);
});


function loadFromUrl(): void {
  const q = new URLSearchParams(location.search).get("n")?.trim() ?? "";
  input.value = q;
  if (q) load(q);
  else result.replaceChildren(renderWelcome());
}

async function load(q: string): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  result.replaceChildren(renderLoading(q));
  try {
    const res = await fetch(`/api/panda/${encodeURIComponent(q)}`, { signal: controller.signal });
    const body = (await res.json()) as HistoryResult | ApiError;
    if (controller.signal.aborted) return;
    result.replaceChildren(...("error" in body ? renderError(body) : renderHistory(body)));
  } catch (err) {
    if (controller.signal.aborted) return;
    result.replaceChildren(
      h("div", { class: "notice error" }, h("p", {}, `The check didn't finish: ${err instanceof Error ? err.message : err}. Try again.`)),
    );
  }
}

// --- Rendering ---

// What the server does for a lookup, shown in turn while it works. The server answers in one go,
// so these describe the work rather than track progress.
const DIG_STEPS = [
  "Lifting the dumpster lid",
  "Digging through every metadata update",
  "Fetching the mint-day metadata",
  "Comparing the six traits",
  "Checking the art",
  "Still digging. Some Pandas have a lot of history",
];

// A row of blocks joined by a thin line, with a pulse travelling along it: the history being read
// off the chain, block by block.
function signal(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const count = 9;
  const size = 10;
  const gap = 16;
  const width = count * size + (count - 1) * gap;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "signal");
  svg.setAttribute("viewBox", `0 0 ${width} ${size}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("x2", String(width));
  line.setAttribute("y1", String(size / 2));
  line.setAttribute("y2", String(size / 2));
  svg.append(line);
  for (let i = 0; i < count; i++) {
    const block = document.createElementNS(NS, "rect");
    block.setAttribute("x", String(i * (size + gap)));
    block.setAttribute("width", String(size));
    block.setAttribute("height", String(size));
    block.setAttribute("rx", "2");
    block.style.setProperty("--i", String(i));
    svg.append(block);
  }
  return svg;
}

function renderLoading(q: string): HTMLElement {
  const trimmed = q.trim().replace(/^#\s*/, "");
  const label = /^\d+$/.test(trimmed) ? `#${Number(trimmed)}` : shortenAddresses(trimmed);
  const status = h("p", { class: "dig-status", role: "status" }, `${DIG_STEPS[0]}…`);
  const box = h(
    "section",
    { class: "dig" },
    signal(),
    h("p", { class: "dig-number" }, label),
    status,
    h("p", { class: "dig-note" }, "The first look can take up to a minute."),
  );
  let i = 0;
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    i = Math.min(i + 1, DIG_STEPS.length - 1);
    status.textContent = `${DIG_STEPS[i]}…`;
  }, 2800);
  return box;
}

function renderWelcome(): HTMLElement {
  return h(
    "section",
    { class: "welcome" },
    h("h1", {}, "Check your Panda's art & traits"),
    h(
      "p",
      {},
      "Enter a Degen Trash Panda number to compare its art & six traits today with the day it was minted.",
    ),
    h("p", {}, "Try ", lookupLink("15700", "#15700"), " or ", randomLink(), "."),
  );
}

function renderError(body: ApiError): Node[] {
  const box = h("div", { class: "notice error" }, h("p", {}, sentence(body.detail)));
  if (body.candidates?.length) {
    box.append(
      h("p", {}, "This number is on more than one mint. Pick one:"),
      h("ul", {}, ...body.candidates.map((mint) => h("li", {}, lookupLink(mint, mint)))),
    );
  }
  return [box];
}

function renderHistory(r: HistoryResult): Node[] {
  const nodes: Node[] = [renderHero(r)];
  if (r.verdictChanges.some((c) => c.field === "image")) nodes.push(renderCompare(r));
  nodes.push(renderTimeline(r), renderFooter(r));
  return nodes;
}

const STAMP: Record<HistoryResult["verdict"], { text: string; cls: string }> = {
  Original: { text: "Original", cls: "ok" },
  "Traits/art changed": { text: "Swapped", cls: "bad" },
  Exalted: { text: "Exalted", cls: "exalted" },
  Unknown: { text: "Unchecked", cls: "unknown" },
};

function renderHero(r: HistoryResult): HTMLElement {
  const stamp = STAMP[r.verdict];
  const mintDate = longDate(r.steps[0]?.blockTime ?? null);
  const changed = r.verdictChanges.map((c) => (c.field === "image" ? "the art" : titleCase(c.field)));

  const headline = {
    Original: "Untouched since mint",
    "Traits/art changed": "Swapped since mint",
    Exalted: "Exalted since mint",
    Unknown: "Can't tell yet",
  }[r.verdict];
  const exaltedOn = longDate(r.exaltedAt);
  const detail =
    r.verdict === "Original"
      ? `The art and all six traits match the mint${mintDate ? ` on ${mintDate}` : ""}.`
      : r.verdict === "Exalted"
        ? `The background changed when it was exalted${exaltedOn ? ` on ${exaltedOn}` : ""}. All six traits match the mint.`
      : r.verdict === "Traits/art changed"
        ? `${capitalise(listJoin(changed))} ${changed.length === 1 ? "differs" : "differ"} from the mint${mintDate ? ` on ${mintDate}` : ""}.`
        : sentence(r.warnings[0] ?? "Part of the history couldn't be fetched.");

  const notes: string[] = [];
  if (r.changedInHistory) notes.push("The art or traits changed at some point and were later put back.");
  if (r.burned) notes.push("This Panda has been burned: its metadata account no longer exists.");
  for (const w of r.warnings) if (!(r.verdict === "Unknown" && w === r.warnings[0])) notes.push(sentence(w));

  return h(
    "section",
    { class: `hero ${stamp.cls}` },
    h(
      "figure",
      { class: "hero-art" },
      thumb(r.current.image, r.number !== null ? `Degen Trash Panda #${r.number}` : "This Panda's current art", "hero-img"),
      h("span", { class: `stamp ${stamp.cls}`, "aria-hidden": "true" }, stamp.text),
    ),
    h(
      "div",
      { class: "hero-text" },
      h("p", { class: "collection" }, "Degen Trash Panda"),
      h("h1", { class: "number" }, r.number !== null ? `#${r.number}` : "No number"),
      h("p", { class: `headline ${stamp.cls}` }, headline),
      h("p", { class: "detail" }, detail),
      notes.length ? h("ul", { class: "notes" }, ...notes.map((n) => h("li", {}, n))) : "",
      renderTraits(r),
      h("p", { class: "links" }, "Mint ", solscan("token", r.mint)),
    ),
  );
}

// The six traits and the image, mint vs now. This is what the verdict is about.
function renderTraits(r: HistoryResult): HTMLElement {
  const mint = readTraits(r.steps[0]?.json ?? null).values;
  const changed = new Map(r.verdictChanges.map((c) => [c.field, c]));

  const row = (label: string, value: Node | string, status: Node | string, isChanged: boolean) =>
    h(
      "div",
      { class: `trait${isChanged ? " changed" : ""}` },
      h("dt", {}, label),
      h("dd", {}, value),
      h("dd", { class: "status" }, status),
    );
  const same = () => h("span", { class: "same", title: "Same as at mint" }, "✓");

  const imageChange = changed.get("image");
  const exaltArt = r.verdict === "Exalted";
  const imageStatus =
    imageChange && r.current.image
      ? h("span", {}, exaltArt ? "changed when exalted, " : "now ", safeLink(r.current.image, exaltArt ? "see it" : "different"))
      : r.imageCheck === "unknown"
        ? "not compared"
        : same();

  return h(
    "dl",
    { class: "traits", "aria-label": "Traits at mint and now" },
    ...TRAITS.map((t) => {
      const c = changed.get(t);
      return row(titleCase(t), mint.get(t) ?? "none", c ? `now ${c.to ?? "missing"}` : same(), Boolean(c));
    }),
    row("Art", r.original.image ? safeLink(r.original.image, "original image") : "none", imageStatus, Boolean(imageChange) && !exaltArt),
    exaltedRow(r, mint.get(EXALTED) ?? null),
  );
}

// The exalted attribute (see src/exalted.ts) is shown alongside the traits.
function exaltedRow(r: HistoryResult, atMint: string | null): Node | string {
  const now = readTraits(r.steps.at(-1)?.json ?? null).values.get(EXALTED) ?? null;
  if (atMint === null && now === null) return "";
  // Early on, an exalted attribute was its own trait ("TELL_ME_A_JOKE": "Mint Date") before it
  // moved into EXALTED_STAT, so "added" is the first step with either form.
  const names = exaltedNames(r.steps.map((s) => s.json));
  const has = (s: Step) => [...readTraits(s.json).values.keys()].some((k) => k === EXALTED || names.has(k));
  const changedAt =
    atMint === null ? r.steps.find(has) : r.steps.findLast((s) => s.diff.some((c) => c.path === `attributes.${EXALTED}`));
  const when = changedAt ? ` ${shortDate(changedAt.blockTime)}` : "";
  const status =
    atMint === now
      ? h("span", { class: "same", title: "Same as at mint" }, "✓")
      : atMint === null
        ? `added${when}`
        : now === null
          ? `removed${when}`
          : `changed${when}`;
  return h(
    "div",
    { class: "trait exalted" },
    h("dt", {}, "Exalted"),
    h("dd", {}, prettyExalted(now ?? atMint ?? "")),
    h("dd", { class: "status" }, status),
  );
}

// "TELL_ME_A_JOKE: Mint Date" -> "Tell me a joke: Mint Date"
function prettyExalted(value: string): string {
  const [stat = "", ...rest] = value.split(":");
  const name = capitalise(stat.trim().replaceAll("_", " ").toLowerCase());
  return rest.length ? `${name}:${rest.join(":")}` : name;
}

function renderCompare(r: HistoryResult): HTMLElement {
  return h(
    "section",
    { class: "compare" },
    h("figure", {}, thumb(r.original.image, "Art at mint"), h("figcaption", {}, "At mint")),
    h("figure", {}, thumb(r.current.image, "Art now"), h("figcaption", {}, "Now")),
  );
}

function renderTimeline(r: HistoryResult): HTMLElement {
  const swapSteps = r.steps.filter(hasSwap).length;
  const names = exaltedNames(r.steps.map((s) => s.json));
  const list = h("ol", { class: "timeline" }, ...r.steps.map((step) => renderStep(step, names)));
  const empty = h("p", { class: "empty" }, "No update ever touched the art or the six traits.");

  // On by default: the full history is one click away.
  const toggle = h("input", { type: "checkbox", id: "only-swaps" }) as HTMLInputElement;
  toggle.checked = true;
  const apply = () => {
    list.classList.toggle("only-swaps", toggle.checked);
    empty.hidden = !(toggle.checked && swapSteps === 0);
  };
  toggle.addEventListener("change", apply);
  apply();

  return h(
    "section",
    { class: "history" },
    h(
      "div",
      { class: "history-head" },
      h("h2", {}, "History"),
      h("label", { class: "toggle" }, toggle, h("span", {}, "Only trait and art changes")),
    ),
    h("p", { class: "history-sub" }, historySummary(r.steps.length - 1, swapSteps)),
    empty,
    list,
  );
}

function historySummary(updates: number, swaps: number): string {
  if (updates <= 0) return "No updates since mint.";
  const which = swaps === 0 ? "none" : swaps === updates ? "all" : `${swaps}`;
  return `${updates} ${updates === 1 ? "update" : "updates"} since mint, ${which} of which touched the art or traits.`;
}

function renderStep(step: Step, exalted: Set<string>): HTMLElement {
  const swaps = step.diff.filter((c) => c.tag === "swap");
  const cosmetic = step.diff.filter((c) => c.tag === "cosmetic");
  const artChanged = swaps.some((c) => c.path === "image");
  // Being exalted changed the background art: say so, in gold rather than red.
  const exaltArt = artChanged && swaps.length === 1 && addsExalted(step.diff, exalted);
  const others = listJoin(
    unique(cosmeticPhrases(cosmetic, exalted)).filter(
      (p) => !(artChanged && p === "art re-hosted") && !(exaltArt && p === "exalted attribute added"),
    ),
  );
  // A change found across a gap of unreadable metadata happened somewhere in that span.
  const span = step.gapSince !== null ? `, sometime between ${shortDate(step.gapSince)} and ${shortDate(step.blockTime)}` : "";
  const summary =
    exaltArt
      ? `Exalted, which changed the background${span}${others ? `, plus ${others}` : ""}`
      : swaps.length > 0
      ? `Changed ${listJoin(swaps.map(swapName))}${span}${others ? `, plus ${others}` : ""}`
      : step.index === 0
        ? "Starting art and traits"
        : `${capitalise(others) || "No visible change"}${step.jsonError ? " (file no longer online)" : ""}`;
  const gapNote =
    step.gapSince !== null
      ? h(
          "p",
          { class: "gap-note" },
          `The metadata between ${shortDate(step.gapSince)} and ${shortDate(step.blockTime)} is no longer online, so the exact update can't be known. The changes above compare the last readable metadata with this one.`,
        )
      : "";

  return h(
    "li",
    { class: `step${swaps.length ? " has-swap" : ""}${exaltArt ? " has-exalt" : ""}` },
    h(
      "details",
      {},
      h(
        "summary",
        {},
        h("time", { title: step.dateUtc ? `${step.dateUtc} UTC` : "" }, shortDate(step.blockTime)),
        h("span", { class: "step-title" }, stepTitle(step)),
        h("span", { class: "step-summary" }, summary),
      ),
      h(
        "div",
        { class: "step-body" },
        thumb(step.image, `Art at this update`, "step-img"),
        h(
          "div",
          {},
          swaps.length ? h("div", { class: "chips" }, ...swaps.map(chip)) : "",
          cosmetic.length ? h("div", { class: "chips" }, ...cosmetic.map(chip)) : "",
          h(
            "dl",
            { class: "facts" },
            h("dt", {}, "Transaction"),
            h("dd", {}, step.sig ? solscan("tx", step.sig) : "read from the metadata account"),
            h("dt", {}, "Instruction"),
            h("dd", {}, step.kind),
            ...(step.authority ? [h("dt", {}, "Authority"), h("dd", {}, short(step.authority))] : []),
            ...(step.txSigners.length ? [h("dt", {}, "Signed by"), h("dd", {}, ...join(step.txSigners.map(short)))] : []),
            h("dt", {}, "Metadata"),
            h("dd", {}, step.uri ? safeLink(step.uri, hostOf(step.uri)) : "none"),
          ),
          gapNote,
          step.jsonError ? h("p", { class: "error-inline" }, `Metadata file no longer online (${step.jsonError}).`) : "",
          step.json ? h("details", { class: "json" }, h("summary", {}, "Metadata file"), h("pre", {}, JSON.stringify(step.json, null, 2))) : "",
        ),
      ),
    ),
  );
}

function renderFooter(r: HistoryResult): HTMLElement {
  return h(
    "footer",
    { class: "foot" },
    r.otherMetadataIx.length
      ? h(
          "details",
          {},
          h("summary", {}, `${r.otherMetadataIx.length} other metadata instructions`),
          h(
            "ul",
            {},
            ...r.otherMetadataIx.map((o) =>
              h("li", {}, `${shortDate(o.dateUtc ? Date.parse(o.dateUtc) / 1000 : null)}, ${o.kind}, `, solscan("tx", o.sig)),
            ),
          ),
        )
      : "",
    h("p", {}, `Built from ${r.signaturesScanned} transactions on ${longDate(Date.parse(r.cachedAt) / 1000)}. Metadata account `, short(r.metadataPda), "."),
  );
}

function chip(c: Change): HTMLElement {
  const path = shortenAddresses(c.path);
  const text = c.label ? `${path}: ${c.label}` : `${path}: ${fmt(c.from)} → ${fmt(c.to)}`;
  return h("span", { class: `chip ${c.tag}`, title: `${c.path}\n${full(c.from)}\n→ ${full(c.to)}` }, text);
}

// --- Words ---

function stepTitle(step: Step): string {
  if (step.kind.startsWith("Create")) return "Minted";
  if (step.sig === null) return "Current state";
  return "Metadata updated";
}

function swapName(c: Change): string {
  return c.path === "image" ? "the art" : titleCase(c.path.replace(/^attributes\./, ""));
}

function cosmeticPhrases(changes: Change[], exalted: Set<string>): string[] {
  const isOldForm = (c: Change) => exalted.has(c.path.replace(/^attributes\./, "").toUpperCase());
  const stat = changes.find((c) => c.path === `attributes.${EXALTED}`);
  const oldForm = changes.filter(isOldForm);
  const renamed = stat?.from === "missing" && oldForm.some((c) => c.to === "missing");

  const phrases: string[] = [];
  if (renamed) phrases.push("exalted attribute renamed");
  else if (stat) phrases.push(stat.from === "missing" ? "exalted attribute added" : stat.to === "missing" ? "exalted attribute removed" : "exalted attribute changed");
  for (const c of oldForm) {
    if (renamed && c.to === "missing") continue;
    phrases.push(c.from === "missing" ? "exalted attribute added" : c.to === "missing" ? "exalted attribute removed" : "exalted attribute changed");
  }
  for (const c of changes) {
    if (c === stat || isOldForm(c)) continue;
    phrases.push(cosmeticPhrase(c));
  }
  return phrases;
}

function cosmeticPhrase(c: Change): string {
  const p = c.path;
  if (p === "uri") return c.label === "URI host move" ? "metadata re-hosted" : "new metadata file";
  if (p.startsWith("creators.") || p === "properties.creators") return "creators changed";
  if (p === "updateAuthority") return "update authority changed";
  if (p === "primarySaleHappened") return "marked as sold";
  if (p === "sellerFeeBasisPoints" || p === "seller_fee_basis_points") return "royalty changed";
  if (p === "image" || p === "properties.files") return "art re-hosted";
  if (p === "attributes.❤️") return "❤️ count changed";
  if (p.startsWith("attributes.")) return `${p.slice("attributes.".length)} changed`;
  if (p === "isMutable") return "lock setting changed";
  if (p === "collection") return "collection changed";
  if (p === "name" || p === "symbol" || p === "description") return `${p} changed`;
  return "other details changed";
}

// --- Small helpers ---

type Child = Node | string;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function hasSwap(step: Step): boolean {
  return step.diff.some((c) => c.tag === "swap");
}

function short(value: string): HTMLElement {
  return h("span", { class: "addr", title: value }, value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value);
}

function solscan(kind: "tx" | "token", id: string): HTMLElement {
  return h("a", { href: `https://solscan.io/${kind}/${id}`, target: "_blank", rel: "noopener noreferrer", title: id }, short(id));
}

// Ask the server for a random Panda number from the index, then look it up.
async function lookupRandom(): Promise<void> {
  try {
    const res = await fetch("/api/random");
    const body = (await res.json()) as { number?: number; detail?: string };
    if (!res.ok || body.number === undefined) throw new Error(body.detail ?? `HTTP ${res.status}`);
    input.value = String(body.number);
    form.requestSubmit();
  } catch (err) {
    result.replaceChildren(
      h("div", { class: "notice error" }, h("p", {}, `Couldn't pick a random Panda: ${err instanceof Error ? err.message : err}.`)),
    );
  }
}

function randomLink(): HTMLElement {
  const a = h("a", { href: "#", role: "button" }, "a random Panda");
  a.addEventListener("click", (event) => {
    event.preventDefault();
    lookupRandom();
  });
  return a;
}

function lookupLink(q: string, text: string): HTMLElement {
  const a = h("a", { href: `?n=${encodeURIComponent(q)}` }, text);
  a.addEventListener("click", (event) => {
    event.preventDefault();
    input.value = q;
    form.requestSubmit();
  });
  return a;
}

// Metadata JSON comes from anyone who controls the URI, so only http(s) URLs become links or images.
function isHttp(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safeLink(url: string, text: string): Child {
  return isHttp(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text;
}

// The frame holds the grey placeholder and a loading spinner (CSS, shown only if loading is
// slow); the image fades in over it once it has loaded.
function thumb(url: string | null, alt: string, cls = ""): HTMLElement {
  if (!url || !isHttp(url)) return h("div", { class: `thumb empty ${cls}` }, "No image");
  const img = h("img", { class: "thumb-img", alt, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  const frame = h("div", { class: `thumb loading ${cls}` }, img);
  img.addEventListener("load", () => {
    img.classList.add("loaded");
    frame.classList.remove("loading");
  });
  img.addEventListener("error", () => {
    frame.classList.remove("loading");
    frame.classList.add("empty");
    frame.replaceChildren("Image unavailable");
  });
  img.setAttribute("src", url);
  return frame;
}

function join(nodes: HTMLElement[]): Child[] {
  return nodes.flatMap((n, i) => (i === 0 ? [n] : [", ", n]));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sentence(s: string): string {
  const t = capitalise(s.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function shortDate(blockTime: number | null): string {
  if (blockTime === null) return "Now";
  return new Date(blockTime * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function longDate(blockTime: number | null): string {
  if (blockTime === null || Number.isNaN(blockTime)) return "";
  return new Date(blockTime * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function fmt(v: unknown): string {
  const s = shortenAddresses(full(v));
  return s.length > 48 ? `${s.slice(0, 22)}…${s.slice(-22)}` : s;
}

function shortenAddresses(s: string): string {
  return s.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (a) => `${a.slice(0, 4)}…${a.slice(-4)}`);
}

function full(v: unknown): string {
  if (v === null || v === undefined) return "none";
  return typeof v === "string" ? v : JSON.stringify(v);
}

document.querySelector("#random")?.addEventListener("click", lookupRandom);

// Start last, so every constant above is defined before the first render.
window.addEventListener("popstate", loadFromUrl);
loadFromUrl();
