import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { TOKEN_METADATA_PROGRAM_ID } from "./constants.ts";

const programId = address(TOKEN_METADATA_PROGRAM_ID);
const addressEncoder = getAddressEncoder();

// Seeds: ["metadata", programId, mint]
export async function metadataPda(mint: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["metadata", addressEncoder.encode(programId), addressEncoder.encode(address(mint))],
  });
  return pda;
}
