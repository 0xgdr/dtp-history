import { expect, test } from "bun:test";
import { loadConfig, redactUrl } from "../src/config.ts";

test("RPC_URL wins, public RPC is the fallback", () => {
  expect(loadConfig({ RPC_URL: "https://rpc.example/?api-key=k" }).rpcUrl).toBe("https://rpc.example/?api-key=k");
  expect(loadConfig({}).rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  expect(loadConfig({ RPC_RPS: "nope", PORT: "4000" })).toMatchObject({ rpcRps: 8, port: 4000, cacheDir: ".cache" });
});

test("S3_BUCKET switches the cache to a bucket, under a prefix by default", () => {
  expect(loadConfig({})).toMatchObject({ cacheBucket: null, cachePrefix: "dtp-history/cache/" });
  expect(loadConfig({ S3_BUCKET: "stuff", CACHE_PREFIX: "" })).toMatchObject({ cacheBucket: "stuff", cachePrefix: "" });
});

test("redactUrl never shows a key in the query or the path", () => {
  expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=secret")).toBe("https://mainnet.helius-rpc.com/<redacted>");
  expect(redactUrl("https://x.quiknode.pro/secret/")).toBe("https://x.quiknode.pro/<redacted>");
  expect(redactUrl("https://api.mainnet-beta.solana.com")).toBe("https://api.mainnet-beta.solana.com");
  expect(redactUrl("not a url secret")).toBe("<redacted>");
});
