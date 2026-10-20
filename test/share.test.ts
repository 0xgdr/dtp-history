import { expect, test } from "bun:test";
import { siteOrigin, withShareTags } from "../src/share.ts";

const HTML = `<html><head>
<meta property="og:url" content="/" />
<meta property="og:image" content="/og.png" />
<meta name="twitter:image" content="/og.png" />
<meta property="og:title" content="Trash Panda Check" />
</head></html>`;

test("origin comes from PUBLIC_URL, then the forwarded host, then the request", () => {
  const req = new Request("http://localhost:8080/?n=55", {
    headers: { "x-forwarded-host": "dtp.up.railway.app", "x-forwarded-proto": "https" },
  });
  expect(siteOrigin(req, "https://pandas.example")).toBe("https://pandas.example");
  expect(siteOrigin(req, null)).toBe("https://dtp.up.railway.app");
  expect(siteOrigin(new Request("http://localhost:3000/"), null)).toBe("http://localhost:3000");
});

test("a bad host or scheme gives no origin", () => {
  const bad = new Request("http://localhost/", { headers: { "x-forwarded-host": "evil.com/<script>" } });
  expect(siteOrigin(bad, null)).toBeNull();
  const scheme = new Request("http://localhost/", { headers: { "x-forwarded-proto": "javascript" } });
  expect(siteOrigin(scheme, null)).toBeNull();
});

test("share-card URLs become absolute; other tags are untouched", async () => {
  const out = await withShareTags(HTML, "https://dtp.up.railway.app", "/?n=55");
  expect(out).toContain('<meta property="og:url" content="https://dtp.up.railway.app/?n=55" />');
  expect(out).toContain('<meta property="og:image" content="https://dtp.up.railway.app/og.png" />');
  expect(out).toContain('<meta name="twitter:image" content="https://dtp.up.railway.app/og.png" />');
  expect(out).toContain('<meta property="og:title" content="Trash Panda Check" />');
});

test("without an origin the page is unchanged", async () => {
  expect(await withShareTags(HTML, null, "/")).toBe(HTML);
});
