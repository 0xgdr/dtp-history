import { getBase58Encoder } from "@solana/kit";

const base58 = getBase58Encoder();

// The subset of a `getTransaction` result (encoding "json") that we read.
export type RawInstruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
};

export type RawTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number };
      instructions: RawInstruction[];
    };
  };
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
};

export type FlatInstruction = {
  // "3" for top-level instruction 3 (0-based, as in `innerInstructions.index`), "3.1" for the
  // first inner instruction under it (1-based, as explorers number them).
  ixPath: string;
  programId: string;
  accounts: string[];
  data: Uint8Array;
};

export type FlatTransaction = {
  sig: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  signers: string[];
  instructions: FlatInstruction[];
};

// Static keys first, then lookup-table writable, then lookup-table readonly. This is the
// order account indices refer to in v0 transactions.
export function accountList(tx: RawTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

export function flattenTransaction(tx: RawTransaction): FlatTransaction {
  const keys = accountList(tx);
  const { message } = tx.transaction;

  const resolve = (index: number): string => {
    const key = keys[index];
    if (key === undefined) throw new Error(`account index ${index} out of range (${keys.length} keys)`);
    return key;
  };
  const toFlat = (ix: RawInstruction, ixPath: string): FlatInstruction => ({
    ixPath,
    programId: resolve(ix.programIdIndex),
    accounts: ix.accounts.map(resolve),
    data: new Uint8Array(base58.encode(ix.data)),
  });

  const innerByIndex = new Map<number, RawInstruction[]>();
  for (const group of tx.meta?.innerInstructions ?? []) innerByIndex.set(group.index, group.instructions);

  const instructions: FlatInstruction[] = [];
  message.instructions.forEach((ix, i) => {
    instructions.push(toFlat(ix, `${i}`));
    (innerByIndex.get(i) ?? []).forEach((inner, j) => instructions.push(toFlat(inner, `${i}.${j + 1}`)));
  });

  return {
    sig: tx.transaction.signatures[0] ?? "",
    slot: tx.slot,
    blockTime: tx.blockTime,
    failed: tx.meta?.err != null,
    signers: message.accountKeys.slice(0, message.header.numRequiredSignatures),
    instructions,
  };
}
