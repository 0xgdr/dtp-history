// Starts the app in src/site.ts. Vercel's Bun runtime ships the files in src/ but didn't ship the
// packages they import (requests failed with "Cannot find package '@solana/kit'"), so on Vercel the
// server runs from src/site.gen.js instead: the same app with its packages bundled in, written by
// `bun run build` (scripts/build-server.ts).
const { options } = Bun.env.VERCEL ? await import("./site.gen.js") : await import("./site.ts");

const server = Bun.serve(options);

console.log(`Listening on ${server.url}`);

// The host sends SIGTERM when a new deploy replaces this one. Stop taking requests, let the ones
// in flight finish (up to 10 s), then exit cleanly instead of being killed mid-request.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: finishing in-flight requests, then exiting`);
    await Promise.race([server.stop(), Bun.sleep(10_000)]);
    process.exit(0);
  });
}
