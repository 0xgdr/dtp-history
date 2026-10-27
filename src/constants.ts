export const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const DTP_COLLECTION_MINT = "GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb";

// The candy machine creator, verified on every Panda at mint. Some Pandas (e.g. #5642) have their
// collection field pointing elsewhere and unverified, so this is what proves they belong.
export const DTP_CREATOR = "CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp";

// The six traits that decide the verdict. Everything else is cosmetic.
export const TRAITS = ["HEAD", "BODY", "MOUTH", "GLASSES", "BACKGROUND", "FUR"] as const;

export const KNOWN_AUTHORITIES = {
  updateAuthority: "7v4VH5LVbqHqv9EXaakFBedD6eoeXS9K8M9BMVhu5DcE",
  updateSigner: "trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH",
} as const;

export const PANDA_NAME_RE = /^Degen Trash Panda #(\d+)$/;
