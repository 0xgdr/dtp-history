const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export type Config = {
  rpcUrl: string;
  rpcRps: number;
  rpcConcurrency: number;
  cacheDir: string;
  // Set: the cache lives in this S3/R2 bucket (credentials from S3_* variables) and cacheDir is unused.
  cacheBucket: string | null;
  cachePrefix: string;
  // Set with cacheBucket: copy this file cache into the bucket in the background at startup.
  copyCacheFrom: string | null;
  port: number;
  publicUrl: string | null;
};

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    // RPC_URL carries the provider key (e.g. Helius `?api-key=`), so it is a secret.
    rpcUrl: env.RPC_URL?.trim() || PUBLIC_RPC,
    rpcRps: positiveNumber(env.RPC_RPS, 8),
    rpcConcurrency: positiveNumber(env.RPC_CONCURRENCY, 4),
    cacheDir: env.CACHE_DIR?.trim() || ".cache",
    cacheBucket: env.S3_BUCKET?.trim() || null,
    // Keeps the cache apart from anything else in a shared bucket.
    cachePrefix: env.CACHE_PREFIX?.trim() ?? "dtp-history/cache/",
    copyCacheFrom: env.COPY_CACHE_FROM?.trim() || null,
    port: positiveNumber(env.PORT, 3000),
    // Site origin for share-card URLs. Unset: taken from each request's host.
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null,
  };
}

// Use this whenever an RPC URL could end up in a log line or an error message. Providers put the
// key in the query (Helius) or the path (QuickNode, Alchemy), so only the host is kept.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecretPart = (u.pathname !== "/" && u.pathname !== "") || u.search !== "";
    return `${u.protocol}//${u.host}${hasSecretPart ? "/<redacted>" : ""}`;
  } catch {
    return "<redacted>";
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : fallback;
}
