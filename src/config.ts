const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export type Config = {
  rpcUrl: string;
  rpcRps: number;
  cacheDir: string;
  port: number;
};

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    // RPC_URL carries the provider key (e.g. Helius `?api-key=`), so it is a secret.
    rpcUrl: env.RPC_URL?.trim() || PUBLIC_RPC,
    rpcRps: positiveNumber(env.RPC_RPS, 8),
    cacheDir: env.CACHE_DIR?.trim() || ".cache",
    port: positiveNumber(env.PORT, 3000),
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
