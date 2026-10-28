import { describe, expect, test } from "bun:test";
import { address, getAddressEncoder } from "@solana/kit";
import { DTP_COLLECTION_MINT, DTP_IMMORTAL_COLLECTION_MINT, TOKEN_METADATA_PROGRAM_ID } from "../src/constants.ts";
import { decodeMetadataAccount } from "../src/decode/metadata-account.ts";
import { decodeMetadataEvents, type MetadataEvent } from "../src/decode/metadata-ix.ts";
import { BorshWriter, PDA_6872, fixture, flatTx, syntheticTx } from "./helpers.ts";

const TRSH = "trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH";

async function events(stamp: string): Promise<MetadataEvent[]> {
  return decodeMetadataEvents(await flatTx(stamp), PDA_6872);
}

async function only(stamp: string): Promise<MetadataEvent> {
  const list = await events(stamp);
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe("#6872 fixtures", () => {
  test("2021-11-23 mint: Create via candy machine CPI, then an inner update", async () => {
    const list = await events("20211123-4XXQoh4g");
    expect(list.map((e) => [e.ixPath, e.kind])).toEqual([
      ["5.2", "CreateMetadataAccount"],
      ["5.6", "CreateMasterEdition"],
      ["5.12", "UpdateMetadataAccount"],
    ]);
    const create = list[0]!;
    expect(create.data?.name).toBe("Degen Trash Panda #6872");
    expect(create.data?.uri).toBe("https://arweave.net/wS8w3NFld2wyvTQDyeyiirGMgOD7mrh82wPzxVbXuQY");
    expect(create.isMutable).toBe(true);
    // The update hands authority to the project and sets primary sale, without touching data.
    const update = list[2]!;
    expect(update.data).toBeUndefined();
    expect(update.updateAuthority).toBe(TRSH);
    expect(update.primarySaleHappened).toBe(true);
  });

  test("2021-11-27 and 2021-11-29 move the URI", async () => {
    expect((await only("20211127-CsqjiE7V")).data?.uri).toStartWith("https://arweave.net/dEdDE4RR");
    expect((await only("20211129-3cntZMxq")).data?.uri).toStartWith("https://arweave.net/HK4b1FL5");
  });

  test("2023-07-14 decodes as Update (V1)", async () => {
    for (const stamp of ["20230714-4qwyWu7m", "20230714-EG5TdDmM"]) {
      const e = await only(stamp);
      expect(e.kind).toBe("Update");
      expect(e.authority).toBe(TRSH);
      expect(e.data?.uri).toStartWith("https://arweave.net/HK4b1FL5");
    }
  });

  test("2022-04-20 joins the verified collection", async () => {
    const e = (await events("20220420-5HjXjGKP")).find((x) => x.collectionChange);
    expect(e?.kind).toBe("SetAndVerifyCollection");
    expect(e?.collectionChange).toEqual({ verified: true, key: DTP_COLLECTION_MINT });
  });

  test("2026-10-12 moves to ardrive and changes creators", async () => {
    const before = await only("20230714-EG5TdDmM");
    const e = await only("20261012-jFCW1AmM");
    expect(e.kind).toBe("Update");
    expect(e.data?.uri).toBe("https://ardrive.net/TUfvuT7r8St-HoH9yJ8876AEi0r3a6gh4R6_NT-Yw3k");
    expect(e.data?.creators).not.toEqual(before.data?.creators);
  });

  test("batch txs yield exactly one event for this PDA", async () => {
    for (const stamp of ["20220602-63uNFLBX", "20221009-5Fpjuhmt", "20261012-jFCW1AmM", "20261013-44k7YL6V"]) {
      const tx = await flatTx(stamp);
      const metadataIxs = tx.instructions.filter((ix) => ix.programId === TOKEN_METADATA_PROGRAM_ID);
      expect(metadataIxs.length).toBeGreaterThan(1);
      expect(decodeMetadataEvents(tx, PDA_6872)).toHaveLength(1);
    }
  });

  test("noise tx yields no events", async () => {
    expect(await events("noise-2Xj3xdnA")).toEqual([]);
  });

  test("the last decoded URI matches the metadata account", async () => {
    const account = await fixture<{ value: { data: [string, string] } }>("account.json");
    const decoded = decodeMetadataAccount(Buffer.from(account.value.data[0], "base64"));
    expect(decoded.data.name).toBe("Degen Trash Panda #6872");
    expect(decoded.data.uri).toBe((await only("20261012-jFCW1AmM")).data?.uri ?? "");
    expect(decoded.collection).toEqual({ verified: true, key: "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb" });
  });
});

describe("synthetic instructions", () => {
  const authority = TRSH;

  test("UpdateMetadataAccountV2 with data: None and primary_sale: Some(true)", () => {
    const data = new BorshWriter().u8(15).u8(0).u8(0).u8(1).u8(1).u8(0).build();
    const tx = syntheticTx(TOKEN_METADATA_PROGRAM_ID, [PDA_6872, authority], data);
    const [e] = decodeMetadataEvents(tx, PDA_6872);
    expect(e?.kind).toBe("UpdateMetadataAccountV2");
    expect(e?.data).toBeUndefined();
    expect(e?.updateAuthority).toBeUndefined();
    expect(e?.primarySaleHappened).toBe(true);
    expect(e?.isMutable).toBeUndefined();
    expect(e?.authority).toBe(authority);
  });

  test("UpdateMetadataAccountV2 with data and a new update authority", () => {
    const newAuthority = new Uint8Array(getAddressEncoder().encode(address(authority)));
    const data = new BorshWriter()
      .u8(15)
      .u8(1)
      .string("Degen Trash Panda #1\0\0")
      .string("DTP")
      .string("https://arweave.net/x")
      .u16(500)
      .u8(0) // creators: None
      .u8(0) // collection: None
      .u8(0) // uses: None
      .u8(1)
      .bytes(newAuthority)
      .u8(0)
      .u8(1)
      .u8(0)
      .build();
    const [e] = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, [PDA_6872, authority], data), PDA_6872);
    expect(e?.data).toEqual({
      name: "Degen Trash Panda #1",
      symbol: "DTP",
      uri: "https://arweave.net/x",
      sellerFeeBasisPoints: 500,
      creators: null,
    });
    expect(e?.updateAuthority).toBe(authority);
    expect(e?.isMutable).toBe(false);
  });

  const pubkey = (a: string) => new Uint8Array(getAddressEncoder().encode(address(a)));
  // Update = [authority, delegateRecord, token, mint, metadata, ...]
  const updateAccounts = [authority, TOKEN_METADATA_PROGRAM_ID, TOKEN_METADATA_PROGRAM_ID, authority, PDA_6872];
  // Verify/Unverify = [authority, delegateRecord, metadata, collectionMint, ...]
  const verifyAccounts = [authority, TOKEN_METADATA_PROGRAM_ID, PDA_6872, DTP_IMMORTAL_COLLECTION_MINT];

  test("Update V1 that sets the collection, unverified (like #5642 on 2024-01-26)", () => {
    const data = new BorshWriter()
      .u8(50)
      .u8(0) // V1
      .u8(0) // new_update_authority: None
      .u8(0) // data: None
      .u8(0) // primary_sale_happened: None
      .u8(0) // is_mutable: None
      .u8(2) // collection: Set
      .u8(0)
      .bytes(pubkey(DTP_IMMORTAL_COLLECTION_MINT))
      .u8(0) // the rest is left unread
      .build();
    const [e] = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, updateAccounts, data), PDA_6872);
    expect(e?.kind).toBe("Update");
    expect(e?.collection).toEqual({ verified: false, key: DTP_IMMORTAL_COLLECTION_MINT });
  });

  test("Update V1 with no collection toggle still decodes, leaving the collection alone", () => {
    const data = new BorshWriter().u8(50).u8(0).u8(0).u8(0).u8(0).u8(1).u8(1).build();
    const [e] = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, updateAccounts, data), PDA_6872);
    expect(e?.kind).toBe("Update");
    expect(e?.isMutable).toBe(true);
    expect(e?.collection).toBeUndefined();
  });

  test("Verify and Unverify of a collection record the collection", () => {
    const verify = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, verifyAccounts, new Uint8Array([52, 1])), PDA_6872);
    expect(verify[0]).toMatchObject({
      kind: "Verify(CollectionV1)",
      collectionChange: { verified: true, key: DTP_IMMORTAL_COLLECTION_MINT },
    });
    const unverify = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, verifyAccounts, new Uint8Array([53, 1])), PDA_6872);
    expect(unverify[0]).toMatchObject({
      kind: "Unverify(CollectionV1)",
      collectionChange: { verified: false, key: DTP_IMMORTAL_COLLECTION_MINT },
    });
  });

  test("Verify of a creator is named but changes no collection", () => {
    const [e] = decodeMetadataEvents(syntheticTx(TOKEN_METADATA_PROGRAM_ID, verifyAccounts, new Uint8Array([52, 0])), PDA_6872);
    expect(e?.kind).toBe("Verify(CreatorV1)");
    expect(e?.collectionChange).toBeUndefined();
  });

  test("garbage data gives Undecodable without throwing", () => {
    const tx = syntheticTx(TOKEN_METADATA_PROGRAM_ID, [PDA_6872, authority], new Uint8Array([1, 1, 0xff, 0xff]));
    const [e] = decodeMetadataEvents(tx, PDA_6872);
    expect(e?.kind).toBe("Undecodable");
    expect(e?.hex).toBe("0101ffff");
  });

  test("a known instruction for another metadata account is ignored", () => {
    const data = new BorshWriter().u8(15).u8(0).u8(0).u8(1).u8(1).u8(0).build();
    const tx = syntheticTx(TOKEN_METADATA_PROGRAM_ID, [authority, PDA_6872], data);
    expect(decodeMetadataEvents(tx, PDA_6872)).toEqual([]);
  });

  test("other programs are ignored", () => {
    const tx = syntheticTx("11111111111111111111111111111111", [PDA_6872, authority], new Uint8Array([15, 0]));
    expect(decodeMetadataEvents(tx, PDA_6872)).toEqual([]);
  });
});
