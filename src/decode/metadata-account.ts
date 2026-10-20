import { BorshReader } from "./borsh.ts";
import { readCollection, readData, type Collection, type MetadataData } from "./metadata-ix.ts";

export type MetadataAccount = {
  key: number;
  updateAuthority: string;
  mint: string;
  data: MetadataData;
  primarySaleHappened: boolean;
  isMutable: boolean;
  editionNonce: number | null;
  tokenStandard: number | null;
  collection: Collection | null;
};

// Decodes the on-chain Metadata account. Fields after `collection` (uses, collection details,
// programmable config) are not needed and are left unread.
export function decodeMetadataAccount(bytes: Uint8Array): MetadataAccount {
  const r = new BorshReader(bytes);
  const key = r.u8();
  const updateAuthority = r.pubkey();
  const mint = r.pubkey();
  const data = readData(r);
  const primarySaleHappened = r.bool();
  const isMutable = r.bool();

  // Accounts created before these fields existed are zero-padded, which reads as `None`.
  // A truncated tail is treated the same way.
  let editionNonce: number | null = null;
  let tokenStandard: number | null = null;
  let collection: Collection | null = null;
  try {
    editionNonce = r.option((x) => x.u8());
    tokenStandard = r.option((x) => x.u8());
    collection = r.option(readCollection);
  } catch {}

  return { key, updateAuthority, mint, data, primarySaleHappened, isMutable, editionNonce, tokenStandard, collection };
}
