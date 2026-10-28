# Collection history: what the chain shows

What we found while building the index, the grids and the home page timeline, with where each
fact comes from. The data files listed here are committed, so none of it needs re-checking on
chain. Counts are as of 28 October 2026.

## Data files

| File | What | Made by | Cost to rebuild |
|---|---|---|---|
| `data/panda-index.json` | Number → mint for every Panda (live, burned, duplicates, missing) | `bun run index` | ~50 DAS calls |
| `data/lists.json` | The grids: exalted, un-exalted, off the collection, lost, Immortal, burned | `bun run index` | same run |
| `data/extra-mints.json` | Pandas DAS won't list (token burned), fetched by id on every build | the index build adds to it | — |
| `data/original-mints.json` | Every mint the original candy machine made, in mint order | `scripts/find-unlisted-mints.ts` | ~16,000 calls, ~50 min; never needs re-running |
| `data/metadata-snapshot.json` | Every Panda's on-chain metadata URI and collection status | `scripts/snapshot-metadata.ts` | ~200 calls |
| `data/mint-traits.json` | Every Panda's six traits, art and date on mint day | `scripts/mint-traits.ts` | ~40,000 calls + 20,000 Arweave fetches, ~2½ hours; never needs re-running |
| `data/art-uploads.json` | When each art file that isn't a Panda's mint-day file was uploaded | `bun run index` (new files only) | ~35 Arweave index queries the first time |

## The numbers

20,000 numbers, #1 to #20000, every one accounted for:

| | Pandas |
|---|---|
| Live | 19,965 |
| Burned | 35 (26 with no metadata account left, 9 token-only burns) |
| Missing | 0 |

## Two creators, two collections

- **Original candy machine** `CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp` (Candy Machine v1,
  program `cndyAnr…`, config `CaNoiCbc…`, since closed). Loaded with **20,000** items, redeemed
  **14,173**, minting from **22 November 2021, 20:40 UTC**. v1 mints its items in order and stops
  where it stopped; every mint is in `data/original-mints.json`.
- **Second creator** `HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx` (its account is closed).
  Verified on about 3,400 further Pandas in the main collection (e.g. #13400, minted 12 January
  2022) and on all the Immortals.
- **Main collection** `GoLMLLR6iSUrA6KsCrFh7f45Uq5EHFQ3p8RmzPoUH9mb`, "Degenerate Trash Pandas",
  update authority `7v4VH5…`. Pandas were verified into it on **20 April 2022**
  (`SetAndVerifyCollection`); some got the same verification again many times through 2022 (#13400
  nine times), which changes nothing.
- **Immortal collection** `Dqzsft8bSXuxG9Mxr3ULrkFYap2c6qtRshFw8YrPhTDX`, "Immortal Degenerate
  Trash Pandas" (symbol DTPI), update authority `DTPiXi8CwGTysnPVuTTvhP47495Z6xrhB5uS7jdqGEH8`.

## The Immortals (June 2023)

**2,395** Pandas minted on **27–28 June 2023** into the numbers the drop never reached, set into the
Immortal collection and verified the next day (an `Update` setting the collection, then `Verify`
with `CollectionV1`). 2,392 are live, 3 burned (#13868, #15849, #17599). They carry the second
creator verified. Example: #14162.

## Off the collection

Six Pandas are in neither collection as verified. Their DTP creator still proves they're genuine,
and the index finds them by creator.

| Panda | Collection now | When |
|---|---|---|
| #5642 | Immortal, unverified | 26 Jan 2024: `Unverify` from main, then an `Update` setting Immortal (unverified), one transaction |
| #15639 | Immortal, unverified | 23 Jan 2024, the same way (minted 24 Mar 2022, verified 20 Apr 2022) |
| #378, #536, #10305 | Immortal, unverified | not traced |
| #1636 | main, unverified | not traced |

## Un-exalted (late 2022)

Nine exalted Pandas now have `EXALTED_STAT: None`: #29, #48, #92, #520, #556, #1020, #1086, #1253,
#1287. Each also had its traits swapped (some gained a Crown, Pirate Hat, Bob or Trashed Vipers,
others were wiped to "No Traits"). In every history it shows at an update on **22 December 2022**
signed by `trshC9…`, but that step follows metadata on Shadow Drive from June or October 2022 that
can't be read, so the exact day is lost. Their stats before: RUGGED_COUNT, B_AND_J, EXILED,
MONOLIFF?.

693 Pandas carry a real exalted stat today; the common ones are RUGGED_COUNT (282),
PSYCHOLOGICAL_TRAUMA_LEVEL (128), TELL_ME_A_JOKE and WEN.

## Token-only burns

Nine Pandas were burned by burning just the token, which leaves the metadata account behind
(supply 0). DAS then leaves them out of every listing, including the burned search, which is why
the index used to call them missing. They're in `data/extra-mints.json`:
#8669 (9 Aug 2023), #8874 (31 Jul 2025), #10596, #10600, #10604, #10605, #10609, #11485, #13014.
The last seven were found by reading every original mint (`scripts/find-unlisted-mints.ts`).

## Shadow Drive, and the October 2026 move off it

From **December 2022** at the latest (#15639's first Shadow Drive URI is 15 December 2022), Pandas'
metadata and art were moved to GenesysGo Shadow Drive. Those files are gone (404), so part of many
Pandas' histories can't be read (see `docs/data-gaps.md`).

Around **12–13 October 2026** the metadata was moved to ArDrive. On chain today
(`data/metadata-snapshot.json`):

| Metadata host | Pandas |
|---|---|
| ardrive.net | 17,567 |
| arweave.net | 2,405 (2,392 Immortals, the 5 off-collection originals, 8 token-burned) |
| shdw-drive.genesysgo.net | **2** |
| no account (burned) | 26 |

17,567 is exactly the live, verified main collection, so the move appears to have covered those.
A sample of 60 moved files all load and point at art that loads. **Two were missed**:

- **#15639** (`AiZysRS9JDHfuVVN8RG9nqkdaN6iPhzcRUfhdpPhtKY2`), live. Unverified since January
  2024, so outside the verified collection. Its URI is
  `https://shdw-drive.genesysgo.net/2rwqrveoGhmWyJ1EKQkKudNeFFhwFtJnZSi92M1caYyo/AiZysRS9JDHfuVVN8RG9nqkdaN6iPhzcRUfhdpPhtKY2.json?ts=1705522203759`.
  Its last readable metadata is from **9 October 2022**
  (`https://arweave.net/DlHq4e2-EcKnaNZdrje7331NJ8DsgojkA7cMHCMzZrg`): Body Down Jacket,
  Background Yellow, Glasses No Traits, Head No Traits, Mouth Bird Foot - Smirk, Fur Scarred
  Brown - Smirk. Its 10 updates since (15 December 2022 to 23 January 2024) are all on Shadow
  Drive, so its current traits and art are unknown. Fixing it needs the same re-upload the others
  got, from the team's own copy of its latest metadata, and an update by `trshC9…`.
- **#11485** (`GymZZWKapArvUfP5Xzq8cV2hRYV5eQrwPtxTKSFgsPr8`), token burned, still verified in the
  main collection. DAS doesn't list token-burned Pandas, which fits a DAS-based sweep missing it.
  Last readable metadata 9 October 2022
  (`https://arweave.net/Lz9yxneC1aRKxffPVQPtaz9bop0So7cQvh12bYtwbdI`); 3 updates since on Shadow
  Drive. Only its history is affected.

Four more burned Pandas (#563, #1278, #5528, #5931) last pointed at Shadow Drive, but their metadata
accounts are gone, so nothing can be updated.

## Duplicates and copycats

Searching Token Metadata by name finds copycats: e.g. "Degen Trash Panda #6872" and "#8669" each
exist a second time from creator `EpRFqi…`, update authority `BV8MTE…`, with no collection. The
index never picks them, because a Panda must be in a DTP collection or carry a verified DTP creator.

## Mint-day traits

`data/mint-traits.json` has every Panda's six traits and art as minted, read from the Create
instruction in its metadata account's first transaction and the file it points at.

A grid Panda gets **Original** when it was **never put through the Boots trait swap**: its current
art is the mint-day file, or a file uploaded in 2021 (an exalt, or a mint-week fix like #12's Body on
23 November 2021). Boots changes only ever show as art uploaded later (`data/art-uploads.json` has
each file's upload date from Arweave's index). An Arweave id always returns the same data, so the
file says whether the art changed; traits alone don't. **#275**'s Boots hoodie changed its art but
not its six traits, which still say "Denim Vest". The swap itself was in the Shadow Drive years, so
it first shows in the October 2026 move to ArDrive, which saved each Panda's art as it then was.

How it was checked: all 700 exalted and un-exalted Pandas were split by when their current art was
uploaded and whether their traits changed. The 39 with Boots-era art but traits as minted had their
histories built, and every one's art had really changed (no re-uploads). Of the 2,425 grid Pandas
still on their mint-day art, none has different traits.

| Grid | Original | Boots | Unknown |
|---|---|---|---|
| Exalted (693) | 521 (468 exalt only, 53 mint-week fixes) | 170 | 2 (art lost) |
| Un-exalted (9) | 0 | 9 | 0 |
| Off the collection (6) | 5 | 0 | 1 (#15639) |
| Immortals (2,395) | 2,395 | 0 | 0 |
| Burned (35) | 30 | 0 | 5 (art lost) |

So "original" here isn't the Panda page's "Untouched since mint": an exalted Panda can be original
(its page says "Exalted"), and so can one with a 2021 fix (#536's page says "Swapped").

#275 also shows its mint-day metadata didn't match its art: Background "Yellow", art blue.

Two things it took to read them all:

- **Helius returns some early-2022 transactions incomplete.** Four Candy Machine v2 mints (#14381,
  #14516, #14584, #15406, 15–16 March 2022) came back with no inner instructions and no logs,
  hiding the Create inside the candy machine's instruction. Solana's public RPC has them whole.
- **Arweave had an outage** during the run (gateway timeouts, a 504 from its own GraphQL), so 248
  files failed first time; all were read on a retry.
