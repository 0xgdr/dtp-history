import { TOKEN_METADATA_PROGRAM_ID } from "../constants.ts";
import type { FlatInstruction, FlatTransaction } from "../tx.ts";
import { BorshReader, stripNulls } from "./borsh.ts";

export type Creator = { address: string; verified: boolean; share: number };
export type Collection = { verified: boolean; key: string };

export type MetadataData = {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: Creator[] | null;
};

export type MetadataEvent = {
  sig: string;
  slot: number;
  blockTime: number | null;
  ixPath: string;
  kind: string;
  authority: string | null;
  txSigners: string[];
  data?: MetadataData;
  updateAuthority?: string;
  primarySaleHappened?: boolean;
  isMutable?: boolean;
  collection?: Collection | null;
  // Set for kind "Undecodable": the raw instruction data, so nothing is lost.
  hex?: string;
  error?: string;
};

type Layout = {
  kind: string;
  metadataIdx: number;
  authorityIdx: number;
  decode: (r: BorshReader) => Partial<MetadataEvent>;
};

// Instructions that can change the metadata state. Account positions follow the
// mpl-token-metadata IDL: Create* = [metadata, mint, mintAuthority, payer, updateAuthority, ...],
// UpdateMetadataAccount* = [metadata, updateAuthority], Update = [authority, delegateRecord,
// token, mint, metadata, ...].
const LAYOUTS: Record<number, Layout> = {
  0: {
    kind: "CreateMetadataAccount",
    metadataIdx: 0,
    authorityIdx: 4,
    decode: (r) => ({ data: readData(r), isMutable: r.bool() }),
  },
  16: {
    kind: "CreateMetadataAccountV2",
    metadataIdx: 0,
    authorityIdx: 4,
    decode: (r) => ({ ...readDataV2(r), isMutable: r.bool() }),
  },
  33: {
    kind: "CreateMetadataAccountV3",
    metadataIdx: 0,
    authorityIdx: 4,
    // Trailing Option<CollectionDetails> is not needed for the history.
    decode: (r) => ({ ...readDataV2(r), isMutable: r.bool() }),
  },
  1: {
    kind: "UpdateMetadataAccount",
    metadataIdx: 0,
    authorityIdx: 1,
    decode: (r) =>
      defined({
        data: r.option(readData) ?? undefined,
        updateAuthority: r.option((x) => x.pubkey()) ?? undefined,
        primarySaleHappened: r.option((x) => x.bool()) ?? undefined,
      }),
  },
  15: {
    kind: "UpdateMetadataAccountV2",
    metadataIdx: 0,
    authorityIdx: 1,
    decode: (r) => {
      const v2 = r.option(readDataV2);
      return defined({
        data: v2?.data,
        collection: v2?.collection,
        updateAuthority: r.option((x) => x.pubkey()) ?? undefined,
        primarySaleHappened: r.option((x) => x.bool()) ?? undefined,
        isMutable: r.option((x) => x.bool()) ?? undefined,
      });
    },
  },
  50: {
    kind: "Update",
    metadataIdx: 4,
    authorityIdx: 0,
    decode: readUpdateArgs,
  },
};

// Decode every Token Metadata instruction in the tx that acts on `metadataPda`.
// Known state-changing instructions count only when the PDA sits in their metadata slot, so
// batch txs that touch many Pandas yield only this Panda's event.
export function decodeMetadataEvents(tx: FlatTransaction, metadataPda: string): MetadataEvent[] {
  const events: MetadataEvent[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId !== TOKEN_METADATA_PROGRAM_ID) continue;
    const event = decodeInstruction(tx, ix, metadataPda);
    if (event) events.push(event);
  }
  return events;
}

export function decodeInstruction(
  tx: FlatTransaction,
  ix: FlatInstruction,
  metadataPda: string,
): MetadataEvent | null {
  const base = {
    sig: tx.sig,
    slot: tx.slot,
    blockTime: tx.blockTime,
    ixPath: ix.ixPath,
    txSigners: tx.signers,
  };
  const disc = ix.data[0];
  const layout = disc === undefined ? undefined : LAYOUTS[disc];

  if (!layout) {
    if (!ix.accounts.includes(metadataPda)) return null;
    if (disc === undefined) return { ...base, kind: "Undecodable", authority: null, hex: "", error: "empty data" };
    return { ...base, kind: `Other(${disc})`, authority: null };
  }

  if (ix.accounts[layout.metadataIdx] !== metadataPda) return null;
  const authority = ix.accounts[layout.authorityIdx] ?? null;
  try {
    const decoded = layout.decode(new BorshReader(ix.data.subarray(1)));
    return { kind: layout.kind, ...decoded, ...base, authority };
  } catch (err) {
    return {
      ...base,
      kind: "Undecodable",
      authority,
      hex: Buffer.from(ix.data).toString("hex"),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readData(r: BorshReader): MetadataData {
  return {
    name: stripNulls(r.string()),
    symbol: stripNulls(r.string()),
    uri: stripNulls(r.string()),
    sellerFeeBasisPoints: r.u16(),
    creators: r.option((x) => x.vec(readCreator)),
  };
}

function readDataV2(r: BorshReader): { data: MetadataData; collection: Collection | null } {
  const data = readData(r);
  const collection = r.option(readCollection);
  r.option((x) => ({ method: x.u8(), remaining: x.u64(), total: x.u64() })); // uses
  return { data, collection };
}

export function readCreator(r: BorshReader): Creator {
  return { address: r.pubkey(), verified: r.bool(), share: r.u8() };
}

export function readCollection(r: BorshReader): Collection {
  return { verified: r.bool(), key: r.pubkey() };
}

// UpdateArgs is an enum. V1 (0) and AsUpdateAuthorityV2 (1) share the same leading fields;
// AsAuthorityItemDelegateV2 (2) has no data; the data delegates (4, 6) carry only data.
// Everything after is_mutable (toggles, rule set, auth data) is left unread.
function readUpdateArgs(r: BorshReader): Partial<MetadataEvent> {
  const variant = r.u8();
  switch (variant) {
    case 0:
    case 1:
      return defined({
        kind: variant === 0 ? "Update" : "Update(AsUpdateAuthorityV2)",
        updateAuthority: r.option((x) => x.pubkey()) ?? undefined,
        data: r.option(readData) ?? undefined,
        primarySaleHappened: r.option((x) => x.bool()) ?? undefined,
        isMutable: r.option((x) => x.bool()) ?? undefined,
      });
    case 2:
      return defined({
        kind: "Update(AsAuthorityItemDelegateV2)",
        updateAuthority: r.option((x) => x.pubkey()) ?? undefined,
        primarySaleHappened: r.option((x) => x.bool()) ?? undefined,
        isMutable: r.option((x) => x.bool()) ?? undefined,
      });
    case 4:
    case 6:
      return defined({
        kind: variant === 4 ? "Update(AsDataDelegateV2)" : "Update(AsDataItemDelegateV2)",
        data: r.option(readData) ?? undefined,
      });
    default:
      return { kind: "Update(unparsed)" };
  }
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
