// Share cards need absolute URLs, but the domain isn't fixed, so the page's og:image,
// twitter:image and og:url are filled in per request from PUBLIC_URL or the request's host.

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function siteOrigin(req: Request, publicUrl: string | null): string | null {
  if (publicUrl) return publicUrl;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  if (!HOST_RE.test(host) || !["http", "https"].includes(proto)) return null;
  return `${proto}://${host}`;
}

export async function withShareTags(html: string, origin: string | null, path: string): Promise<string> {
  if (!origin) return html;
  const absolute = (value: string | null) => (value?.startsWith("/") ? `${origin}${value}` : value);
  return new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(el) {
        const value = absolute(el.getAttribute("content"));
        if (value) el.setAttribute("content", value);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute("content", `${origin}${path}`);
      },
    })
    .transform(new Response(html))
    .text();
}
