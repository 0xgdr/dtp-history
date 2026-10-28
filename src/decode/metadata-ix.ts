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
  // Set for the collection instructions below: the collection this Panda is in afterwards.
  collectionChange?: Collection;
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

// Instructions that verify or unverify a collection, by discriminant. Account positions follow the
// mpl-token-metadata IDL. Verify (52) and Unverify (53) also cover creators: their first arg byte
// is 0 for CreatorV1, 1 for CollectionV1.
const COLLECTION_IXS: Record<number, { kind: string; metadataIdx: number; collectionIdx: number; verified: boolean }> = {
  18: { kind: "VerifyCollection", metadataIdx: 0, collectionIdx: 3, verified: true },
  22: { kind: "UnverifyCollection", metadataIdx: 0, collectionIdx: 2, verified: false },
  25: { kind: "SetAndVerifyCollection", metadataIdx: 0, collectionIdx: 4, verified: true },
  30: { kind: "VerifySizedCollectionItem", metadataIdx: 0, collectionIdx: 3, verified: true },
  31: { kind: "UnverifySizedCollectionItem", metadataIdx: 0, collectionIdx: 3, verified: false },
  32: { kind: "SetAndVerifySizedCollectionItem", metadataIdx: 0, collectionIdx: 4, verified: true },
  52: { kind: "Verify(CollectionV1)", metadataIdx: 2, collectionIdx: 3, verified: true },
  53: { kind: "Unverify(CollectionV1)", metadataIdx: 2, collectionIdx: 3, verified: false },
};

// Other instructions seen on Pandas, named so the page needn't show a bare number.
const OTHER_NAMES: Record<number, string> = {
  10: "CreateMasterEdition",
  17: "CreateMasterEditionV3",
  29: "BurnNft",
  41: "Burn",
  52: "Verify(CreatorV1)",
  53: "Unverify(CreatorV1)",
  54: "Collect",
  56: "Resize",
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
    const collectionIx = COLLECTION_IXS[disc];
    const isCollection = collectionIx && (disc < 52 || ix.data[1] === 1);
    if (isCollection && ix.accounts[collectionIx.metadataIdx] === metadataPda) {
      const key = ix.accounts[collectionIx.collectionIdx];
      if (key) return { ...base, kind: collectionIx.kind, authority: null, collectionChange: { verified: collectionIx.verified, key } };
    }
    return { ...base, kind: OTHER_NAMES[disc] ?? `Other(${disc})`, authority: null };
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

// UpdateArgs is an enum. V1 (0) and AsUpdateAuthorityV2 (1) share the same leading fields, then a
// collection toggle; AsAuthorityItemDelegateV2 (2) has no data; the collection delegates (3, 7)
// start with the toggle; the data delegates (4, 6) carry only data. Everything after the toggle
// (other toggles, rule set, auth data) is left unread.
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
        collection: readCollectionToggle(r),
      });
    case 2:
      return defined({
        kind: "Update(AsAuthorityItemDelegateV2)",
        updateAuthority: r.option((x) => x.pubkey()) ?? undefined,
        primarySaleHappened: r.option((x) => x.bool()) ?? undefined,
        isMutable: r.option((x) => x.bool()) ?? undefined,
      });
    case 3:
    case 7:
      return defined({
        kind: variant === 3 ? "Update(AsCollectionDelegateV2)" : "Update(AsCollectionItemDelegateV2)",
        collection: readCollectionToggle(r),
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

// CollectionToggle: None (0) leaves it alone, Clear (1) removes it, Set (2) replaces it. It comes
// after the fields the history depends on, so if it can't be read the update still counts, as one
// that left the collection alone.
function readCollectionToggle(r: BorshReader): Collection | null | undefined {
  try {
    const toggle = r.u8();
    if (toggle === 1) return null;
    if (toggle === 2) return readCollection(r);
  } catch {
    // fall through
  }
  return undefined;
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
