// Types for src/page.gen.js, which `bun run build` (scripts/build-page.ts) generates.

// The bundled page, served at "/"; its asset URLs are relative ("./chunk-….js").
export const html: string;
// Everything else the page loads, plus /og.png, keyed by URL path.
export const assets: Record<string, { type: string; base64: string }>;
