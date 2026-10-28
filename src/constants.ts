export const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const DTP_COLLECTION_MINT = "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb";

// "Immortal Degenerate Trash Pandas" (DTPI), the collection of the June 2023 mint.
export const DTP_IMMORTAL_COLLECTION_MINT = "Dqzsft8bSXuxG9Mxr3ULrkFYap2c6qtRshFw8YrPhTDX";

// The two candy machine creators, one of them verified on every Panda. The Immortal Pandas (minted
// June 2023 into numbers the original drop left unminted) are in their own collection, and a few
// Pandas (e.g. #5642) have an unverified collection, so the creator is what proves they belong.
export const DTP_CREATORS = [
  "CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp",
  "HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx",
] as const;

// The six traits that decide the verdict. Everything else is cosmetic.
export const TRAITS = ["HEAD", "BODY", "MOUTH", "GLASSES", "BACKGROUND", "FUR"] as const;

export const KNOWN_AUTHORITIES = {
  updateAuthority: "7v4VH5LVbqHqv9EXaakFBedD6eoeXS9K8M9BMVhu5DcE",
  updateSigner: "trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH",
} as const;

export const PANDA_NAME_RE = /^Degen Trash Panda #(\d+)$/;
