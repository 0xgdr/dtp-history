import { expect, test } from "bun:test";
import { RpcError, createRpc } from "../src/rpc.ts";

test("retries 429 and 5xx, then returns the result", async () => {
  const statuses = [429, 503];
  const impl = (async () => {
    const status = statuses.shift();
    return status ? new Response("busy", { status }) : Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
  }) as unknown as typeof fetch;
  expect(await createRpc("https://rpc.example/?api-key=secret", { rps: 1000, fetchImpl: impl }).call("getSlot", [])).toBe(42);
});

test("gives up with a redacted error", async () => {
  const impl = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
  const rpc = createRpc("https://rpc.example/?api-key=secret", { rps: 1000, fetchImpl: impl });
  const err = await rpc.call<never>("getSlot", []).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RpcError);
  expect(err.message).not.toContain("secret");
});

test("JSON-RPC errors are not retried", async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } });
  }) as unknown as typeof fetch;
  await expect(createRpc("https://rpc.example", { rps: 1000, fetchImpl: impl }).call("getSlot", [])).rejects.toThrow("invalid params");
  expect(calls).toBe(1);
});
