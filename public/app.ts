// Type-only imports are erased by Bun's bundler, so the page shares the API's types for free.
// traits.ts is tiny and dependency-free, so the page reuses the server's trait matching.
import { TRAITS } from "../src/constants.ts";
import type { Change } from "../src/diff.ts";
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

window.addEventListener("popstate", loadFromUrl);
loadFromUrl();

function loadFromUrl(): void {
  const q = new URLSearchParams(location.search).get("n")?.trim() ?? "";
  input.value = q;
  if (q) load(q);
  else result.replaceChildren();
}

async function load(q: string): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  result.replaceChildren(
    h("div", { class: "loading" }, h("span", { class: "spinner" }), "Rebuilding history from chain… the first load can take 10–30 s."),
  );
  try {
    const res = await fetch(`/api/panda/${encodeURIComponent(q)}`, { signal: controller.signal });
    const body = (await res.json()) as HistoryResult | ApiError;
    if (controller.signal.aborted) return;
    result.replaceChildren(...("error" in body ? renderError(res.status, body) : renderHistory(body)));
  } catch (err) {
    if (controller.signal.aborted) return;
    result.replaceChildren(h("div", { class: "error" }, `Request failed: ${err instanceof Error ? err.message : err}`));
  }
}

// --- Rendering ---

function renderError(status: number, body: ApiError): Node[] {
  const box = h("div", { class: "error" }, h("strong", {}, `${status} `), body.detail);
  if (body.candidates?.length) {
    box.append(
      h("p", {}, "Pick one of the mints:"),
      h("ul", {}, ...body.candidates.map((mint) => h("li", {}, lookupLink(mint, mint)))),
    );
  }
  return [box];
}

function renderHistory(r: HistoryResult): Node[] {
  const nodes: Node[] = [renderVerdict(r), renderTraits(r)];
  const swapSteps = r.steps.filter(hasSwap).length;
  const timeline = h("ol", { class: "timeline" }, ...r.steps.map(renderStep));
  const empty = h("p", { class: "muted", hidden: "" }, "No step changed the traits or the art.");
  const toggle = h("input", { type: "checkbox", id: "only-swaps" }) as HTMLInputElement;
  toggle.addEventListener("change", () => {
    timeline.classList.toggle("only-swaps", toggle.checked);
    empty.hidden = !(toggle.checked && swapSteps === 0);
  });
  nodes.push(
    h(
      "div",
      { class: "timeline-head" },
      h("h2", {}, `Timeline (${r.steps.length} steps)`),
      h("label", { class: "toggle" }, toggle, ` Only steps with trait/art changes (${swapSteps})`),
    ),
    empty,
    timeline,
  );
  if (r.otherMetadataIx.length > 0) nodes.push(renderOther(r));
  nodes.push(
    h(
      "p",
      { class: "meta" },
      `${r.signaturesScanned} signatures scanned · metadata PDA `,
      code(r.metadataPda),
      ` · built ${new Date(r.cachedAt).toUTCString()}`,
    ),
  );
  return nodes;
}

const VERDICT_CLASS: Record<HistoryResult["verdict"], string> = {
  Original: "ok",
  "Traits/art changed": "bad",
  Unknown: "unknown",
};

function renderVerdict(r: HistoryResult): HTMLElement {
  const title = r.number !== null ? `Degen Trash Panda #${r.number}` : "Unnumbered mint";
  const banner = h(
    "section",
    { class: `verdict ${VERDICT_CLASS[r.verdict]}` },
    thumb(r.current.image, "current image", "verdict-thumb"),
    h(
      "div",
      {},
      h("p", { class: "verdict-label" }, r.verdict),
      h("p", {}, h("strong", {}, title), " · mint ", solscan("token", r.mint)),
    ),
  );
  const notes: Node[] = [];
  if (r.burned) notes.push(h("li", {}, "Burned: the metadata account no longer exists."));
  if (r.changedInHistory) notes.push(h("li", {}, "The art or traits changed at some point and were later restored."));
  for (const w of r.warnings) notes.push(h("li", {}, w));
  if (notes.length) banner.querySelector("div")!.append(h("ul", { class: "warnings" }, ...notes));
  return banner;
}

// The six traits and the image, mint vs now, with changed rows highlighted. Always shown, since
// this is what the verdict is about.
function renderTraits(r: HistoryResult): HTMLElement {
  const box = h("section", { class: "changes" });
  const imageChanged = r.verdictChanges.some((c) => c.field === "image");
  if (imageChanged) {
    box.append(
      h(
        "div",
        { class: "compare" },
        h("figure", {}, thumb(r.original.image, "original image"), h("figcaption", {}, "At mint")),
        h("figure", {}, thumb(r.current.image, "current image"), h("figcaption", {}, "Now")),
      ),
    );
  }

  const mint = readTraits(r.steps[0]?.json ?? null).values;
  const now = readTraits(r.steps.at(-1)?.json ?? null).values;
  const changed = new Set(r.verdictChanges.map((c) => c.field));
  const row = (label: string, from: string, to: string, isChanged: boolean) =>
    h("tr", isChanged ? { class: "changed" } : {}, h("td", {}, label), h("td", {}, from), h("td", {}, isChanged ? to : "same"));
  const imageNow = { same: "same", rehosted: "same (re-hosted)", different: "changed", unknown: "not compared" }[r.imageCheck];

  box.append(
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Trait"), h("th", {}, "At mint"), h("th", {}, "Now"))),
      h(
        "tbody",
        {},
        ...TRAITS.map((t) => row(t, mint.get(t) ?? "missing", now.get(t) ?? "missing", changed.has(t))),
        h(
          "tr",
          imageChanged ? { class: "changed" } : {},
          h("td", {}, "Image"),
          h("td", {}, r.original.image ? safeLink(r.original.image, "at mint") : "missing"),
          h("td", {}, imageChanged && r.current.image ? safeLink(r.current.image, "changed") : imageNow),
        ),
      ),
    ),
  );
  return box;
}

function hasSwap(step: Step): boolean {
  return step.diff.some((c) => c.tag === "swap");
}

function renderStep(step: Step): HTMLElement {
  const swaps = step.diff.filter((c) => c.tag === "swap");
  const cosmetic = step.diff.filter((c) => c.tag === "cosmetic");
  return h(
    "li",
    { class: `step${swaps.length ? " has-swap" : ""}` },
    thumb(step.image, `image at step ${step.index}`, "step-thumb"),
    h(
      "div",
      { class: "step-body" },
      h(
        "p",
        { class: "step-head" },
        h("span", { class: "date" }, step.dateUtc ? `${step.dateUtc} UTC` : "date unknown"),
        h("span", { class: "kind" }, step.kind),
        step.sig ? solscan("tx", step.sig) : h("span", { class: "muted" }, "from the metadata account"),
      ),
      h(
        "dl",
        {},
        ...(step.authority ? [h("dt", {}, "Authority"), h("dd", {}, short(step.authority))] : []),
        ...(step.txSigners.length ? [h("dt", {}, "Signers"), h("dd", {}, ...join(step.txSigners.map(short)))] : []),
        h("dt", {}, "URI"),
        h("dd", {}, step.uri ? safeLink(step.uri, step.uri) : "none"),
      ),
      swaps.length ? h("div", { class: "chips" }, ...swaps.map(chip)) : "",
      step.index === 0
        ? h("p", { class: "muted" }, "Mint state")
        : swaps.length === 0
          ? h("p", { class: "muted" }, "No trait or art change")
          : "",
      cosmetic.length
        ? h(
            "details",
            { class: "other-changes" },
            h("summary", {}, `${cosmetic.length} other ${cosmetic.length === 1 ? "change" : "changes"}`),
            h("div", { class: "chips" }, ...cosmetic.map(chip)),
          )
        : "",
      step.jsonError ? h("p", { class: "error-inline" }, `JSON unavailable: ${step.jsonError}`) : "",
      step.json ? h("details", {}, h("summary", {}, "Metadata JSON"), h("pre", {}, JSON.stringify(step.json, null, 2))) : "",
    ),
  );
}

function renderOther(r: HistoryResult): HTMLElement {
  return h(
    "details",
    { class: "other" },
    h("summary", {}, `Other metadata instructions (${r.otherMetadataIx.length})`),
    h(
      "ul",
      {},
      ...r.otherMetadataIx.map((o) =>
        h("li", {}, `${o.dateUtc ?? "?"} · ${o.kind} · `, solscan("tx", o.sig), o.hex ? h("code", {}, ` ${o.hex}`) : ""),
      ),
    ),
  );
}

function chip(c: Change): HTMLElement {
  const path = shortenAddresses(c.path);
  const text = c.label ? `${path}: ${c.label}` : `${path}: ${fmt(c.from)} → ${fmt(c.to)}`;
  return h("span", { class: `chip ${c.tag}`, title: `${c.path}\n${full(c.from)}\n→ ${full(c.to)}` }, text);
}

// --- Small helpers ---

type Child = Node | string;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function short(value: string): HTMLElement {
  return h("span", { class: "addr", title: value }, value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value);
}

function code(value: string): HTMLElement {
  return h("code", { title: value }, short(value));
}

function solscan(kind: "tx" | "token", id: string): HTMLElement {
  return h("a", { href: `https://solscan.io/${kind}/${id}`, target: "_blank", rel: "noopener noreferrer", title: id }, short(id));
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

function safeLink(url: string, text: string): Child {
  return isHttp(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text;
}

function thumb(url: string | null, alt: string, cls = ""): HTMLElement {
  if (!url || !isHttp(url)) return h("div", { class: `thumb empty ${cls}` }, "no image");
  return h("img", { class: `thumb ${cls}`, src: url, alt, loading: "lazy", referrerpolicy: "no-referrer" });
}

function join(nodes: HTMLElement[]): Child[] {
  return nodes.flatMap((n, i) => (i === 0 ? [n] : [", ", n]));
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
