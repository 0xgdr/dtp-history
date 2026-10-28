import { expect, test } from "bun:test";
import { siteOrigin, withShareTags } from "../src/share.ts";

const HTML = `<html><head>
<title>Trash Panda Check</title>
<meta name="description" content="Check your Panda" />
<meta property="og:description" content="Check your Panda" />
<meta name="twitter:description" content="Check your Panda" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Trash Panda Check" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Trash Panda Check" />
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

test("a Panda's card sets its title, description and square art, escaped", async () => {
  const out = await withShareTags(HTML, "https://dtp.example", "/?n=5642", {
    title: "Degen Trash Panda #5642: Untouched since mint",
    description: 'The art & all six traits match the mint. <b>"ok"</b>',
    image: "/thumb?src=https%3A%2F%2Farweave.net%2Fabc",
    imageAlt: "Degen Trash Panda #5642",
  });
  expect(out).toContain("<title>Degen Trash Panda #5642: Untouched since mint</title>");
  expect(out).toContain('<meta property="og:title" content="Degen Trash Panda #5642: Untouched since mint" />');
  expect(out).toContain('<meta name="twitter:title" content="Degen Trash Panda #5642: Untouched since mint" />');
  expect(out).toContain('<meta property="og:image" content="https://dtp.example/thumb?src=https%3A%2F%2Farweave.net%2Fabc" />');
  expect(out).toContain('<meta property="og:image:width" content="400" />');
  expect(out).toContain('<meta name="twitter:card" content="summary" />');
  expect(out).toContain('<meta property="og:image:alt" content="Degen Trash Panda #5642" />');
  // Quotes are escaped, so a description can't close its attribute; inside one, < and & are inert.
  expect(out).toContain('<meta name="description" content="The art & all six traits match the mint. <b>&quot;ok&quot;</b>" />');
});

test("a card without art keeps the site's wide image and card type", async () => {
  const out = await withShareTags(HTML, "https://dtp.example", "/?n=1", {
    title: "Degen Trash Panda #1 · Trash Panda Check",
    description: "See its history",
    image: null,
    imageAlt: "Degen Trash Panda #1",
  });
  expect(out).toContain('<meta property="og:image" content="https://dtp.example/og.png" />');
  expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(out).toContain('<meta property="og:image:width" content="1200" />');
});
