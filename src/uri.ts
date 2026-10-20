const ARWEAVE_HOSTS = new Set(["arweave.net", "www.arweave.net", "ardrive.net", "ar-io.net"]);
const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export type UriInfo = {
  // `ar:<id>` for Arweave-hosted content, otherwise the normalized URL.
  key: string;
  arweaveId: string | null;
  normalized: string;
};

export function normalizeUri(raw: string): UriInfo {
  const trimmed = raw.replace(/\0+$/, "").trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { key: trimmed, arweaveId: null, normalized: trimmed };
  }
  url.hash = "";
  url.search = "";
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`;

  const isArweaveHost = ARWEAVE_HOSTS.has(host) || host.endsWith(".arweave.net");
  const firstSegment = path.split("/")[1] ?? "";
  if (isArweaveHost && ARWEAVE_ID_RE.test(firstSegment)) {
    return { key: `ar:${firstSegment}`, arweaveId: firstSegment, normalized };
  }
  return { key: normalized, arweaveId: null, normalized };
}

// Gateways to try, in order: the original URL first, then the two main Arweave gateways.
export function gatewayUrls(raw: string): string[] {
  const { arweaveId } = normalizeUri(raw);
  if (!arweaveId) return [raw];
  return [...new Set([raw, `https://arweave.net/${arweaveId}`, `https://ardrive.net/${arweaveId}`])];
}

// What the browser loads for a thumbnail.
export function displayUrl(key: string): string {
  return key.startsWith("ar:") ? `https://arweave.net/${key.slice(3)}` : key;
}
