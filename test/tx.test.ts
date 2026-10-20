import { expect, test } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { accountList, flattenTransaction, type RawTransaction } from "../src/tx.ts";
import { rawTx } from "./helpers.ts";

const b58 = (bytes: number[]) => getBase58Decoder().decode(new Uint8Array(bytes));

test("inner instructions follow their parent in execution order", async () => {
  const tx = flattenTransaction(await rawTx("20211123-4XXQoh4g"));
  const paths = tx.instructions.map((ix) => ix.ixPath);
  const at5 = paths.indexOf("5");
  expect(paths[at5 + 1]).toBe("5.1");
  expect(paths.indexOf("5.12")).toBeGreaterThan(paths.indexOf("5.2"));
  // Nothing but 5.x sits between "5" and the next top-level instruction.
  const between = paths.slice(at5 + 1, paths.indexOf("6") === -1 ? undefined : paths.indexOf("6"));
  expect(between.every((p) => p.startsWith("5."))).toBe(true);
  expect(tx.signers).toContain("p1kGTLmPty2LxRn5MG5AqqPJQQaxmALzQPQ7xc4bUrf");
});

test("v0 account indices resolve through loadedAddresses (writable, then readonly)", () => {
  const raw: RawTransaction = {
    slot: 1,
    blockTime: 0,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: ["Signer", "Program"],
        header: { numRequiredSignatures: 1 },
        instructions: [{ programIdIndex: 1, accounts: [0, 2, 3, 4], data: b58([7]) }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [4], data: b58([8]) }] }],
      loadedAddresses: { writable: ["LoadedW"], readonly: ["LoadedR1", "LoadedR2"] },
    },
  };
  expect(accountList(raw)).toEqual(["Signer", "Program", "LoadedW", "LoadedR1", "LoadedR2"]);
  const flat = flattenTransaction(raw);
  expect(flat.instructions.map((ix) => [ix.ixPath, ix.accounts, [...ix.data]])).toEqual([
    ["0", ["Signer", "LoadedW", "LoadedR1", "LoadedR2"], [7]],
    ["0.1", ["LoadedR2"], [8]],
  ]);
  expect(flat.signers).toEqual(["Signer"]);
  expect(flat.failed).toBe(false);
});
