// Which images /thumb will shrink (src/thumb.ts), shared with the page so it only asks for those.
// Arweave and ArDrive addresses are content hashes, so a thumbnail never goes stale and can be
// cached for good, and the endpoint can't be used to fetch arbitrary URLs.
const HOSTS = new Set(["arweave.net", "www.arweave.net", "ardrive.net"]);

export function thumbSourceOk(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === "https:" && HOSTS.has(url.host);
  } catch {
    return false;
  }
}
