// Type-only imports are erased by Bun's bundler, so the page shares the API's types for free.
// traits.ts is tiny and dependency-free, so the page reuses the server's trait matching.
import { DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT, TRAITS } from "../src/constants.ts";
import type { Change } from "../src/diff.ts";
import { addsExalted, EXALTED, exaltedNames, isEmptyExaltedStat } from "../src/exalted.ts";
import type { List, Stats } from "../src/api.ts";
import type { CollectionEvent, HistoryResult, Step } from "../src/history.ts";
import { LOST_HOST, type ListEntry, type ListKind } from "../src/lists.ts";
import { thumbSourceOk } from "../src/thumb-source.ts";
import { readTraits } from "../src/traits.ts";

type ApiError = { error: string; detail: string; candidates?: string[] };
// A 202 from the API: the history is still being built.
type Building = { status: "building"; phase: "signatures" | "transactions" | "metadata"; done: number; total: number | null };

const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#q")!;
const result = document.querySelector<HTMLElement>("#result")!;

let inflight: AbortController | null = null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  // A fresh query, so a lookup from a grid doesn't keep ?list= in the URL.
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("n", q);
  history.pushState(null, "", url);
  load(q);
});


function loadFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const q = params.get("n")?.trim() ?? "";
  const list = LISTS.find((l) => l.kind === params.get("list"));
  input.value = q;
  if (q) load(q);
  else if (list) loadList(list);
  else result.replaceChildren(renderWelcome());
}

async function load(q: string): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  const view = loadingView(q);
  result.replaceChildren(view.el);
  try {
    // Long histories answer 202 with progress; keep asking until the result is ready.
    for (;;) {
      const res = await fetch(`/api/panda/${encodeURIComponent(q)}`, { signal: controller.signal });
      const body = (await res.json()) as HistoryResult | ApiError | Building;
      if (controller.signal.aborted) return;
      if (res.status === 202 && "status" in body && body.status === "building") {
        view.show(body);
        await new Promise((r) => setTimeout(r, 2000));
        if (controller.signal.aborted) return;
        continue;
      }
      result.replaceChildren(
        ...("error" in body ? [renderProblem(q, problemFor(res.status, body, q))] : renderHistory(body as HistoryResult)),
      );
      return;
    }
  } catch {
    if (controller.signal.aborted) return;
    result.replaceChildren(renderProblem(q, problemFor(0, null, q)));
  }
}

// --- Rendering ---

// What the server does for a lookup, shown in turn while it works. Once the server reports real
// progress (long histories), the counts replace these.
const DIG_STEPS = [
  "Lifting the dumpster lid",
  "Digging through every metadata update",
  "Fetching the mint-day metadata",
  "Comparing the six traits",
  "Checking the art",
  "Still digging. Some Pandas have a lot of history",
];

// A row of blocks joined by a thin line, with a pulse travelling along it: the history being read
// off the chain, block by block. Broken: still, with a gap in the line and the middle block red.
function signal(broken = false): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const count = 9;
  const size = 10;
  const gap = 16;
  const width = count * size + (count - 1) * gap;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", broken ? "signal broken" : "signal");
  svg.setAttribute("viewBox", `0 0 ${width} ${size}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const middle = Math.floor(count / 2);
  const snap = middle * (size + gap); // left edge of the middle block
  const segments: [number, number][] = broken
    ? [
        [0, snap - gap / 2 - 2],
        [snap + size + gap / 2 + 2, width],
      ]
    : [[0, width]];
  for (const [x1, x2] of segments) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y1", String(size / 2));
    line.setAttribute("y2", String(size / 2));
    svg.append(line);
  }
  for (let i = 0; i < count; i++) {
    const block = document.createElementNS(NS, "rect");
    if (broken && i === middle) block.setAttribute("class", "snapped");
    block.setAttribute("x", String(i * (size + gap)));
    block.setAttribute("width", String(size));
    block.setAttribute("height", String(size));
    block.setAttribute("rx", "2");
    block.style.setProperty("--i", String(i));
    svg.append(block);
  }
  return svg;
}

// "#118" for a number, a shortened address for a mint.
function lookupLabel(q: string): string {
  const trimmed = q.trim().replace(/^#\s*/, "");
  return /^\d+$/.test(trimmed) ? `#${Number(trimmed)}` : shortenAddresses(trimmed);
}

function loadingView(q: string): { el: HTMLElement; show: (p: Building) => void } {
  const label = lookupLabel(q);
  const bar = signal();
  const status = h("p", { class: "dig-status", role: "status" }, `${DIG_STEPS[0]}…`);
  const note = h("p", { class: "dig-note" }, "The first look can take up to a minute.");
  const box = h("section", { class: "dig" }, bar, h("p", { class: "dig-number" }, label), status, note);
  let i = 0;
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    i = Math.min(i + 1, DIG_STEPS.length - 1);
    status.textContent = `${DIG_STEPS[i]}…`;
  }, 2800);

  // Real progress: counts in the status line, and the blocks fill up as transactions are read.
  const show = (p: Building) => {
    clearInterval(timer);
    const n = (x: number) => x.toLocaleString("en-GB");
    status.textContent =
      p.phase === "signatures"
        ? `Listing transactions: ${n(p.done)} so far…`
        : p.phase === "transactions"
          ? `Reading transactions: ${n(p.done)} of ${n(p.total ?? 0)}…`
          : `Fetching metadata files: ${n(p.done)} of ${n(p.total ?? 0)}…`;
    if (p.phase !== "metadata" && (p.total ?? p.done) > 500) {
      note.textContent = "This Panda has a long history, so this one takes a few minutes. You can leave this tab open.";
    }
    const blocks = [...bar.querySelectorAll("rect")];
    const fraction = p.phase === "metadata" ? 1 : p.phase === "transactions" && p.total ? p.done / p.total : 0;
    const lit = Math.min(blocks.length, Math.floor(fraction * blocks.length));
    bar.classList.add("progress");
    blocks.forEach((b, k) => {
      b.classList.toggle("lit", k < lit);
      b.classList.toggle("next", k === lit);
    });
  };
  return { el: box, show };
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
    h(
      "p",
      { class: "try" },
      "Try ", // the spaces are for screen readers; flex lays the pills out with a gap
      lookupLink("15700", "#15700", { class: "try-pill" }),
      " or ",
      randomLink({ class: "try-pill outline" }),
    ),
    renderStory(),
  );
}

// The collection's own history, as read from the chain while building this. The live counts come
// from /api/stats; the story's own numbers are history and don't change. Each entry shows one
// Panda's art, its image URL looked up once with DAS (getAsset), so the home page never has to
// build a history to draw it.
type StoryEntry = {
  year: string;
  when: string;
  title: string;
  stamp: string;
  text: string;
  art: { n: string; image: string };
  examples: string[];
  tone?: "exalted" | "unexalted" | "immortal" | "burned";
  list?: ListKind;
};

const STORY: StoryEntry[] = [
  {
    year: "2021",
    when: "22 Nov",
    title: "The drop",
    stamp: "Minted",
    text: "A Candy Machine loaded with 20,000 Pandas starts minting on the evening of 22 November (UTC). It mints 14,173 of them, then stops.",
    art: { n: "1", image: "https://arweave.net/iaVc5X5AmXibHvWDs90SMZL-aGh48rcgDD6j3DhTXG8" },
    examples: ["1", "6872"],
  },
  {
    year: "2021",
    when: "Late Nov",
    title: "Exalted",
    stamp: "Exalted",
    text: "Days after mint, some early Pandas are exalted. The update that adds the exalted attribute changes their background art too.",
    art: { n: "55", image: "https://www.arweave.net/odMAVysuwGxXyHH-pj-bhbCFTbIdvcIYYo7fR-KPc3Q?ext=png" },
    examples: ["55", "118"],
    tone: "exalted",
    list: "exalted",
  },
  {
    year: "2022",
    when: "Jan",
    title: "A second creator",
    stamp: "Minted",
    text: "Minting carries on under a second creator address. About 3,400 more Pandas join the collection this way.",
    art: { n: "13400", image: "https://www.arweave.net/7QQcHOuMk1YO6ZWLNCgpdDcDosHG5amekDW9bRQIt00?ext=png" },
    examples: ["13400"],
  },
  {
    year: "2022",
    when: "20 Apr",
    title: "The collection is verified",
    stamp: "Verified",
    text: "Pandas are verified into the Degenerate Trash Pandas collection on chain. Some get the same verification again and again over the following months.",
    art: { n: "6872", image: "https://www.arweave.net/KCPnIoNva-EubeDnc6vLZRrlfijdEVN5Pi2-pz8f0ZQ?ext=png" },
    examples: ["6872", "13400"],
  },
  {
    year: "2022",
    when: "From Dec",
    title: "Lost metadata",
    stamp: "404",
    text: "Pandas' metadata starts moving to GenesysGo Shadow Drive. Those files are gone now, so part of many Pandas' history can't be read.",
    art: { n: "14332", image: "https://arweave.net/qeURwoChCJUGq6e8Cx11gv8s28-rddHp25S8fpcVL-w" },
    examples: ["14332"],
    list: "lost",
  },
  {
    year: "2022",
    when: "By 22 Dec",
    title: "Un-exalted",
    stamp: "Un-exalted",
    text: "Nine exalted Pandas get new traits, and their exalted stat now reads \u201cNone\u201d. Their metadata from those weeks was on Shadow Drive and is gone, so the exact day is lost: by 22 December 2022 it had happened.",
    art: { n: "1020", image: "https://ardrive.net/xK7TFh3q0MZ_RZ_1ThlISFVybbsK5LRpy-dI-RXScx4" },
    examples: ["29", "1020"],
    tone: "unexalted",
    list: "unexalted",
  },
  {
    year: "2023",
    when: "27–28 Jun",
    title: "The Immortals",
    stamp: "Immortal",
    text: "2,395 Pandas are minted into the numbers the drop never reached, in a collection of their own: Immortal Degenerate Trash Pandas.",
    art: { n: "14162", image: "https://www.arweave.net/5UmxUDAq3uoT_KxsOw8PQvHy268ND0VBGwGTi5DVaFY?ext=png" },
    examples: ["14162", "15000"],
    tone: "immortal",
    list: "immortal",
  },
  {
    year: "2024",
    when: "26 Jan",
    title: "#5642 switches collection",
    stamp: "Moved",
    text: "An original from November 2021 is unverified from the main collection and put in the Immortal collection, unverified. #15639 went the same way three days earlier.",
    art: { n: "5642", image: "https://www.arweave.net/GVKXKVtIOS0rEn1w7lhw1gnpWB2hoWK7nwr_K-JC9D8?ext=png" },
    examples: ["5642", "15639"],
    tone: "immortal",
    list: "unverified",
  },
  {
    year: "2026",
    when: "Mid-Oct",
    title: "Back from Shadow Drive",
    stamp: "Rescued",
    text: "17,567 Pandas' metadata moves to ArDrive, matching every live Panda verified in the main collection, so their histories can be read again. Two were missed: #15639 and the burned #11485 still point at Shadow Drive.",
    art: { n: "2026", image: "https://www.arweave.net/Yk9hQgB7QpqZT015s-YVn3b-Hcg8H18KQkfGguHXmHY?ext=png" },
    examples: ["14332", "15639"],
    list: "lost",
  },
  {
    year: "Ever since",
    when: "2022–now",
    title: "Burned",
    stamp: "Burned",
    text: "Pandas get burned now and then. Some owners burned just the token, which leaves the metadata behind and hides the Panda from most indexers.",
    art: { n: "13868", image: "https://www.arweave.net/PRlEOmWcxPBIukdpYIK9hMQwHm1i50kChq3xMawVfL8?ext=png" },
    examples: ["13868", "8669", "10596"],
    tone: "burned",
    list: "burned",
  },
];

function renderStory(): HTMLElement {
  const tiles = { numbers: "numbers", live: "live", burned: "burned", missing: "never found" } as const;
  const values = Object.fromEntries(Object.keys(tiles).map((k) => [k, h("dd", {}, "–")])) as Record<keyof typeof tiles, HTMLElement>;
  const foot = h("p", { class: "story-foot" });
  void fetch("/api/stats")
    .then((res) => (res.ok ? (res.json() as Promise<Stats>) : null))
    .then((stats) => {
      if (!stats) return;
      const fmt = (n: number) => n.toLocaleString("en-GB");
      values.numbers.textContent = fmt(stats.numbers);
      values.live.textContent = fmt(stats.live);
      values.burned.textContent = fmt(stats.burned);
      values.missing.textContent = fmt(stats.missing.length);
      const built = longDate(Date.parse(stats.generatedAt) / 1000);
      const missing = stats.missing.map((n) => `#${n}`);
      foot.textContent = `${missing.length ? `No one has found a Panda for ${listJoin(missing)}. ` : ""}Counts from the index built on ${built}.`;
    })
    .catch(() => {});

  // A year marker opens each year's entries.
  const items: HTMLElement[] = [];
  for (const [i, e] of STORY.entries()) {
    if (STORY[i - 1]?.year !== e.year) items.push(h("li", { class: "story-year", "aria-hidden": "true" }, h("span", {}, e.year)));
    items.push(renderStoryEntry(e));
  }

  return h(
    "section",
    { class: "story", "aria-labelledby": "story-title" },
    h("h2", { id: "story-title" }, "The collection, from the chain"),
    h(
      "dl",
      { class: "stats" },
      ...Object.entries(tiles).map(([k, label]) => h("div", { class: "stat" }, h("dt", {}, label), values[k as keyof typeof tiles])),
    ),
    h("ol", { class: "story-list" }, ...items),
    foot,
  );
}

function renderStoryEntry(e: StoryEntry): HTMLElement {
  const name = `Degen Trash Panda #${e.art.n}`;
  return h(
    "li",
    { class: `story-item${e.tone ? ` ${e.tone}` : ""}` },
    h(
      "article",
      { class: "story-card" },
      h(
        "figure",
        { class: "story-art" },
        lookupLink(e.art.n, thumb(thumbUrl(e.art.image), name, "story-img"), { "aria-label": name }),
        h("span", { class: "story-stamp", "aria-hidden": "true" }, e.stamp),
      ),
      h(
        "div",
        { class: "story-text" },
        h("p", { class: "story-when" }, e.year === "Ever since" ? e.when : `${e.when} ${e.year}`),
        h("h3", {}, e.title),
        h("p", {}, e.text),
      ),
      // The card's footer: the example Pandas on the left, "See every…" on the right.
      h(
        "footer",
        { class: "story-foot-links" },
        h("span", {}, "See ", ...join(e.examples.map((n) => lookupLink(n, `#${n}`)))),
        e.list ? h("span", { class: "story-list-link" }, listLink(e.list)) : "",
      ),
    ),
  );
}

// --- The grids: every exalted, Immortal or burned Panda, from /api/list/:kind ---

const LISTS: { kind: ListKind; title: string; link: string; intro: string }[] = [
  {
    kind: "exalted",
    title: "Exalted Pandas",
    link: "See every exalted Panda",
    intro: "Every Panda carrying an exalted stat today, and what it is. Exalting changed their background art.",
  },
  {
    kind: "unexalted",
    title: "Un-exalted Pandas",
    link: "See every un-exalted Panda",
    intro: "Once exalted, now their exalted stat reads \u201cNone\u201d. Each had its traits swapped in late 2022, when its metadata was on Shadow Drive.",
  },
  {
    kind: "unverified",
    title: "Off the collection",
    link: "See every Panda off the collection",
    intro: "Pandas in neither collection as verified. Most were moved to the Immortal collection without being verified there; their DTP creator still proves they're genuine.",
  },
  {
    kind: "lost",
    title: "Still lost to Shadow Drive",
    link: "See the Pandas still lost",
    intro: "Pandas whose metadata or art still points at GenesysGo Shadow Drive, which is gone. Many more lost part of their history there and later moved off it; they aren't listed.",
  },
  {
    kind: "immortal",
    title: "The Immortals",
    link: "See all the Immortals",
    intro: "Minted on 27–28 June 2023 into the numbers the drop never reached, in the Immortal Degenerate Trash Pandas collection.",
  },
  {
    kind: "burned",
    title: "Burned Pandas",
    link: "See every burned Panda",
    intro: "Gone for good. A few owners burned just the token, which leaves the metadata behind.",
  },
];

function listLink(kind: ListKind): HTMLElement {
  const list = LISTS.find((l) => l.kind === kind)!;
  const a = h("a", { href: `?list=${kind}` }, `${list.link} →`);
  a.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState(null, "", `?list=${kind}`);
    loadFromUrl();
    window.scrollTo(0, 0);
  });
  return a;
}

async function loadList(list: (typeof LISTS)[number]): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  const head = h(
    "header",
    { class: "grid-head" },
    homeLink(),
    h("h1", {}, list.title),
    h("p", { class: "grid-intro" }, list.intro),
  );
  const status = h("p", { class: "grid-count" }, "Loading…");
  result.replaceChildren(h("section", { class: `grid-page ${list.kind}` }, head, status));
  try {
    const res = await fetch(`/api/list/${list.kind}`, { signal: controller.signal });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as List;
    if (controller.signal.aborted) return;
    const burned = body.pandas.filter((p) => p.burned).length;
    status.textContent =
      `${body.pandas.length.toLocaleString("en-GB")} Pandas` +
      (burned && list.kind !== "burned" ? `, ${burned} of them burned` : "") +
      `. From the index built on ${longDate(Date.parse(body.generatedAt) / 1000)}.`;
    status.after(h("ul", { class: "panda-grid" }, ...body.pandas.map(renderGridPanda)));
  } catch {
    if (controller.signal.aborted) return;
    status.textContent = "The list couldn't be loaded. Try again in a moment.";
  }
}

function renderGridPanda(p: ListEntry): HTMLElement {
  const name = `Degen Trash Panda #${p.n}`;
  const lost = p.image !== null && hostOf(p.image) === LOST_HOST;
  return h(
    "li",
    { class: `grid-panda${p.burned ? " burned" : ""}${lost ? " art-lost" : ""}` },
    lookupLink(
      String(p.n),
      h(
        "span",
        { class: "grid-card" },
        // Art lost with Shadow Drive: the last art its history can read, or say it's gone.
        lost && p.lastArt
          ? lostStamped(thumb(thumbUrl(p.lastArt.image), `${name}, last readable art`, "grid-img"))
          : lost
            ? h("div", { class: "thumb empty grid-img" }, "Art lost with Shadow Drive")
            : thumb(thumbUrl(p.image), name, "grid-img"),
        p.burned ? h("span", { class: "grid-burned", "aria-hidden": "true" }, "Burned") : "",
        h("span", { class: "grid-n" }, `#${p.n}`),
        p.stat ? h("span", { class: "grid-stat" }, prettyExalted(p.stat)) : "",
        p.note ? h("span", { class: "grid-stat" }, p.note) : "",
        lost && p.lastArt
          ? h("span", { class: "grid-stat" }, `Last readable art, ${shortDate(Date.parse(p.lastArt.at) / 1000)}. Current art lost.`)
          : "",
      ),
      { "aria-label": `${name}${p.burned ? ", burned" : ""}${lost ? ", current art lost" : ""}` },
    ),
  );
}

// Old art shown in place of art lost with Shadow Drive, stamped so it isn't taken for the current art.
function lostStamped(frame: HTMLElement): HTMLElement {
  frame.append(h("span", { class: "lost-stamp", "aria-hidden": "true" }, "Art lost"));
  return frame;
}

// When a Panda's current metadata or art is on Shadow Drive (gone), the last art its history can
// read, to show flagged. Only for Shadow Drive, so a fetch that merely failed isn't called lost.
function lostArtOf(r: HistoryResult): { image: string; at: number | null; metadataLost: boolean } | null {
  const metadataLost = r.current.jsonUri !== null && hostOf(r.current.jsonUri) === LOST_HOST;
  const artLost = r.current.image !== null && hostOf(r.current.image) === LOST_HOST;
  if (!metadataLost && !artLost) return null;
  const last = r.steps.findLast((s) => s.json && s.image && hostOf(s.image) !== LOST_HOST);
  return last?.image ? { image: last.image, at: last.blockTime, metadataLost } : null;
}

function homeLink(): HTMLElement {
  const a = h("a", { href: "/", class: "grid-back" }, "← The collection");
  a.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState(null, "", "/");
    loadFromUrl();
  });
  return a;
}

type Problem = { title: string; text: string; retry?: boolean; random?: boolean; candidates?: string[] };

// Turns an API error (or a dropped connection, status 0) into words for the problem screen.
function problemFor(status: number, body: ApiError | null, q: string): Problem {
  const label = lookupLabel(q);
  if (status === 0) {
    return {
      title: "Lost the signal",
      text: "The connection dropped before the history came back. It may still be building, so trying again often works.",
      retry: true,
    };
  }
  switch (body?.error) {
    case "duplicate":
      return { title: "Two Pandas, one number", text: `${label} is on more than one mint. Pick one:`, candidates: body.candidates };
    case "missing":
    case "not_found":
      return { title: "Nothing in this dumpster", text: `${label} has no Panda in the collection.`, random: true };
    case "bad_input":
      return { title: "That's not a Panda", text: "Enter a Panda number like 15700, or a mint address.", random: true };
    case "rpc_failed":
      return { title: "The chain isn't answering", text: "The Solana RPC didn't respond after several tries. Give it a moment.", retry: true };
    case "no_index":
      return { title: "Number lookup is offline", text: "Panda numbers can't be looked up right now. A mint address still works." };
    default:
      return {
        title: "Something broke in the dumpster",
        text: "The history couldn't be built. Try again; if it keeps happening, it's on our side.",
        retry: true,
      };
  }
}

// `onRetry` defaults to repeating the lookup; `label` replaces the big number (e.g. for the dice).
function renderProblem(q: string, problem: Problem, onRetry = () => load(q), label = lookupLabel(q)): HTMLElement {
  const actions: Node[] = [];
  if (problem.retry) {
    const retry = h("button", { type: "button", class: "retry" }, "Try again");
    retry.addEventListener("click", onRetry);
    actions.push(retry);
  }
  if (problem.random) actions.push(h("p", { class: "dig-note" }, "Or try ", randomLink(), "."));
  return h(
    "section",
    { class: "dig problem", role: "alert" },
    signal(true),
    h("p", { class: "dig-number" }, label),
    h("p", { class: "dig-status" }, problem.title),
    h("p", { class: "dig-note" }, problem.text),
    problem.candidates?.length
      ? h("ul", { class: "candidates" }, ...problem.candidates.map((mint) => h("li", {}, lookupLink(mint, mint))))
      : "",
    ...actions,
  );
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
  const lostArt = lostArtOf(r);
  // Unknown because the current metadata is on Shadow Drive: that won't change by trying again.
  const lostForGood = r.verdict === "Unknown" && Boolean(lostArt?.metadataLost);

  const headline = lostForGood
    ? "Can't tell"
    : {
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
        : lostForGood
          ? "Its current metadata is lost with GenesysGo Shadow Drive, so its traits today can't be read."
          : sentence(r.warnings[0] ?? "Part of the history couldn't be fetched.");

  const notes: string[] = [];
  if (lostArt) {
    const when = longDate(lostArt.at);
    notes.push(
      `Its current ${lostArt.metadataLost ? "metadata and art are" : "art is"} lost with GenesysGo Shadow Drive. The art shown is the last that can still be read${when ? `, from ${when}` : ""}.`,
    );
  }
  if (r.changedInHistory) notes.push("The art or traits changed at some point and were later put back.");
  const immortal = r.series === "Immortal";
  // A burned Panda's warning says how it was burned (see src/history.ts).
  for (const w of r.warnings) if (!(r.verdict === "Unknown" && w === r.warnings[0])) notes.push(sentence(w));

  return h(
    "section",
    { class: `hero ${stamp.cls}` },
    h(
      "figure",
      { class: `hero-art${r.burned ? " burned" : ""}${lostArt ? " art-lost" : ""}` },
      lostArt
        ? lostStamped(thumb(lostArt.image, `Degen Trash Panda #${r.number}, last readable art`, "hero-img"))
        : thumb(r.current.image, r.number !== null ? `Degen Trash Panda #${r.number}` : "This Panda's current art", "hero-img"),
      h("span", { class: `stamp ${stamp.cls}`, "aria-hidden": "true" }, stamp.text),
    ),
    h(
      "div",
      { class: "hero-text" },
      h("p", { class: "collection" }, immortal ? "Immortal Degen Trash Panda" : "Degen Trash Panda"),
      h("h1", { class: "number" }, r.number !== null ? `#${r.number}` : "No number"),
      renderBadges(r, mintDate),
      h("p", { class: `headline ${stamp.cls}` }, headline),
      h("p", { class: "detail" }, detail),
      notes.length ? h("ul", { class: "notes" }, ...notes.map((n) => h("li", {}, n))) : "",
      renderTraits(r),
      h("p", { class: "links" }, "Mint ", solscan("token", r.mint)),
    ),
  );
}

// Which mint it came from, and whether it's been burned.
function renderBadges(r: HistoryResult, mintDate: string): HTMLElement {
  const immortal = r.series === "Immortal";
  const series = immortal ? "Immortal" : "Original drop";
  return h(
    "p",
    { class: "badges" },
    h(
      "span",
      {
        class: `badge${immortal ? " immortal" : ""}`,
        title: immortal
          ? "Minted in June 2023 into the numbers the original drop left unminted, in the Immortal Degenerate Trash Pandas collection"
          : "Minted in the original Degenerate Trash Pandas drop",
      },
      mintDate ? `${series} · minted ${mintDate}` : series,
    ),
    unexalted(r)
      ? h("span", { class: "badge unexalted", title: "Its exalted stat now reads \u201cNone\u201d" }, "Un-exalted")
      : "",
    r.burned ? h("span", { class: "badge burned" }, "Burned") : "",
  );
}

// Exalted once, but the stat now reads "None" (see isEmptyExaltedStat).
function unexalted(r: HistoryResult): boolean {
  const stat = readTraits(r.steps.at(-1)?.json ?? null).values.get(EXALTED);
  return stat !== undefined && isEmptyExaltedStat(stat);
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
  // An Unknown verdict compared nothing: no change found isn't the same as unchanged.
  const unread = () => h("span", { class: "unread", title: "Its current traits couldn't be read" }, "can't read now");
  const unknown = r.verdict === "Unknown";

  const imageChange = changed.get("image");
  const exaltArt = r.verdict === "Exalted";
  const imageStatus =
    imageChange && r.current.image
      ? h("span", {}, exaltArt ? "changed when exalted, " : "now ", safeLink(r.current.image, exaltArt ? "see it" : "different"))
      : unknown
        ? unread()
        : r.imageCheck === "unknown"
          ? "not compared"
          : same();

  return h(
    "dl",
    { class: "traits", "aria-label": "Traits at mint and now" },
    ...TRAITS.map((t) => {
      const c = changed.get(t);
      return row(titleCase(t), mint.get(t) ?? "none", c ? `now ${c.to ?? "missing"}` : unknown ? unread() : same(), Boolean(c));
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
  const list = h("ol", { class: "timeline" }, ...timelineItems(r).map((item) => ("kind" in item ? renderStep(item, names) : renderCollectionEvents(item))));
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

// Steps and collection events in time order. A collection event follows the step from the same
// transaction; the account's current state (no time) stays last.
function timelineItems(r: HistoryResult): (Step | CollectionEvent[])[] {
  const groups = new Map<string, CollectionEvent[]>();
  for (const e of r.collectionEvents) groups.set(e.sig, [...(groups.get(e.sig) ?? []), e]);
  const items: { at: number; order: number; item: Step | CollectionEvent[] }[] = [
    ...r.steps.map((step) => ({ at: step.blockTime ?? Infinity, order: 0, item: step })),
    ...[...groups.values()].map((events) => ({ at: events[0]!.blockTime ?? Infinity, order: 1, item: events })),
  ];
  return items.sort((a, b) => a.at - b.at || a.order - b.order).map((x) => x.item);
}

const COLLECTION_NAMES: Record<string, string> = {
  [DTP_COLLECTION_MINT]: "the Degenerate Trash Pandas collection",
  [DTP_IMMORTAL_COLLECTION_MINT]: "the Immortal collection",
};

// One transaction's collection changes, e.g. "Unverified from the Degenerate Trash Pandas
// collection, then put in the Immortal collection, unverified".
function renderCollectionEvents(events: CollectionEvent[]): HTMLElement {
  // Setting a collection and verifying it in the same transaction is one move.
  const shown = events.filter(
    (e, i) => !(e.action === "set" && events.slice(i + 1).some((x) => x.action === "verified" && x.collection === e.collection)),
  );
  const name = (key: string | null) => (key ? (COLLECTION_NAMES[key] ?? `collection ${key.slice(0, 4)}…${key.slice(-4)}`) : "");
  const phrase = (e: CollectionEvent) =>
    ({
      verified: `verified into ${name(e.collection)}`,
      unverified: `unverified from ${name(e.collection)}`,
      set: `put in ${name(e.collection)}, unverified`,
      cleared: "taken out of its collection",
    })[e.action];
  const first = events[0]!;
  const immortal = events.some((e) => e.collection === DTP_IMMORTAL_COLLECTION_MINT);
  return h(
    "li",
    { class: `step collection-event${immortal ? " immortal" : ""}` },
    h(
      "div",
      { class: "event-row" },
      h("time", { title: first.dateUtc ? `${first.dateUtc} UTC` : "" }, shortDate(first.blockTime)),
      h("span", { class: "step-title" }, "Collection"),
      h("span", { class: "step-summary" }, capitalise(shown.map(phrase).join(", then ")), " ", solscan("tx", first.sig)),
    ),
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
  // Being exalted changed the background art: say so, in the exalted colour rather than red.
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
  else if (stat) {
    phrases.push(
      stat.from === "missing"
        ? "exalted attribute added"
        : stat.to === "missing"
          ? "exalted attribute removed"
          : isEmptyExaltedStat(String(stat.to))
            ? "exalted stat emptied"
            : "exalted attribute changed",
    );
  }
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
  } catch {
    result.replaceChildren(
      renderProblem(
        "",
        { title: "The dice rolled under the bin", text: "Couldn't pick a random Panda just now.", retry: true },
        lookupRandom,
        "#?",
      ),
    );
  }
}

function randomLink(attrs: Record<string, string> = {}): HTMLElement {
  const a = h("a", { href: "#", role: "button", ...attrs }, "a random Panda");
  a.addEventListener("click", (event) => {
    event.preventDefault();
    lookupRandom();
  });
  return a;
}

function lookupLink(q: string, content: Child, attrs: Record<string, string> = {}): HTMLElement {
  const a = h("a", { href: `?n=${encodeURIComponent(q)}`, ...attrs }, content);
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
// Our own small copy of an Arweave/ArDrive image (src/thumb.ts), for tiles; anything else as is.
function thumbUrl(src: string | null): string | null {
  return src && thumbSourceOk(src) ? `/thumb?src=${encodeURIComponent(src)}` : src;
}

function thumb(url: string | null, alt: string, cls = ""): HTMLElement {
  if (!url || !(isHttp(url) || url.startsWith("/thumb?"))) return h("div", { class: `thumb empty ${cls}` }, "No image");
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
