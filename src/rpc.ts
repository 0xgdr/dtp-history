import { redactUrl } from "./config.ts";

export class RpcError extends Error {}

type Options = { rps: number; concurrency?: number; fetchImpl?: typeof fetch };

const BACKOFF_MS = [500, 1000, 2000, 4000];

// Minimal JSON-RPC client with a token-bucket rate limit, a concurrency cap and retry with
// exponential backoff on 429/5xx. Plain JSON-RPC keeps raw `getTransaction` results exactly as
// the node returns them, which is what the fixtures and decoders expect.
export function createRpc(url: string, { rps, concurrency = 4, fetchImpl = fetch }: Options) {
  let tokens = rps;
  let last = performance.now();
  let active = 0;
  const waiters: (() => void)[] = [];
  let id = 0;

  async function takeToken(): Promise<void> {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(rps, tokens + ((now - last) / 1000) * rps);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await Bun.sleep(((1 - tokens) / rps) * 1000);
    }
  }

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        await takeToken();
        let status = 0;
        try {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(30_000),
          });
          status = res.status;
          if (res.ok) {
            const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
            if (body.error) throw new RpcError(`${method}: ${body.error.code} ${body.error.message}`);
            return body.result as T;
          }
        } catch (err) {
          if (err instanceof RpcError) throw err;
          status = -1; // network error or timeout: retry
        }
        const retryable = status === -1 || status === 429 || status >= 500;
        const delay = BACKOFF_MS[attempt];
        if (!retryable || delay === undefined) {
          throw new RpcError(`${method} failed (status ${status}) via ${redactUrl(url)}`);
        }
        await Bun.sleep(delay);
      }
    } finally {
      release();
    }
  }

  return { call };
}

export type Rpc = ReturnType<typeof createRpc>;
