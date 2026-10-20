import { expect, test } from "bun:test";
import { metadataPda } from "../src/pda.ts";
import { MINT_6872, PDA_6872 } from "./helpers.ts";

test("mint of #6872 derives to its metadata PDA", async () => {
  expect<string>(await metadataPda(MINT_6872)).toBe(PDA_6872);
});
