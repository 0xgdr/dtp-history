// Share cards need absolute URLs, but the domain isn't fixed, so the page's og:image,
// twitter:image and og:url are filled in per request from PUBLIC_URL or the request's host. A link
// to one Panda (?n=5642) also gets its own card: its verdict and its art (see createApi.shareCard).

// A square image (a Panda's art) gets Twitter's "summary" card rather than the wide one.
export type ShareCard = { title: string; description: string; image: string | null; imageAlt: string };
const SQUARE = 400; // the thumbnail size (src/thumb.ts)

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function siteOrigin(req: Request, publicUrl: string | null): string | null {
  if (publicUrl) return publicUrl;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  if (!HOST_RE.test(host) || !["http", "https"].includes(proto)) return null;
  return `${proto}://${host}`;
}

export async function withShareTags(html: string, origin: string | null, path: string, card: ShareCard | null = null): Promise<string> {
  if (!origin) return html;
  const absolute = (value: string | null) => (value?.startsWith("/") ? `${origin}${value}` : value);
  const set = (value: string) => ({ element: (el: HTMLRewriterTypes.Element) => void el.setAttribute("content", value) });
  let rewriter = new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(el) {
        const value = absolute(card?.image ?? el.getAttribute("content"));
        if (value) el.setAttribute("content", value);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute("content", `${origin}${path}`);
      },
    });
  if (card) {
    rewriter = rewriter
      .on("title", { element: (el) => void el.setInnerContent(card.title) })
      .on('meta[property="og:title"], meta[name="twitter:title"]', set(card.title))
      .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', set(card.description))
      .on('meta[property="og:image:alt"]', set(card.imageAlt));
    if (card.image) {
      rewriter = rewriter
        .on('meta[property="og:image:width"], meta[property="og:image:height"]', set(String(SQUARE)))
        .on('meta[name="twitter:card"]', set("summary"));
    }
  }
  return rewriter.transform(new Response(html)).text();
}
