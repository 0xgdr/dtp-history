# Known data gaps

Things in the DTP chain history that the app can't fully recover, and how it handles them.

## Shadow Drive metadata (December 2022 – October 2026)

From December 2022 at the latest (#15639's first Shadow Drive URI is 15 December 2022), Pandas'
metadata URIs were moved to **GenesysGo Shadow Drive** (`shdw-drive.genesysgo.net`). Those files are
now gone: every request returns **404**. Around 12–13 October 2026 the metadata was moved to
ArDrive, except for #15639 and the token-burned #11485, which still point at Shadow Drive (see
`docs/collection-history.md`).

For an affected Panda, every metadata update between the move and the next update that points
somewhere readable has no JSON. For **#14332**, everything between **9 October 2022** and
**12 October 2026** is unreadable:

| Steps | Dates | Metadata | Head |
|---|---|---|---|
| 0–2 | Jul–Oct 2022 | Arweave | Flat Cap |
| 3–7 | Jan–Jul 2023 | Shadow Drive, gone | unknown |
| 8–9 | Oct 2026 | Arweave | No Traits |

**What the app does:** JSON diffs compare against the last readable metadata, so a change made
during a gap shows at the first readable step after it. That step carries `gapSince`, and the page
says the change happened "sometime between" the two dates. Steps inside the gap show "file no longer
online". The verdict (mint vs now) is unaffected, because both ends are readable.

**What can't be known:** which update inside the gap made the change.

## Mint-week art changes (November 2021)

Some early Pandas' art was replaced in the days after mint (around 22–27 November 2021):

- **Exalted Pandas:** the background changed in the same update that added the exalted attribute
  (e.g. #55, #118 on 23 November 2021). The app shows these as **Exalted**, not Swapped
  (`src/exalted.ts`).
- **Other early changes** with no exalt still show as **Swapped** (e.g. #5: Body changed from Down
  Jacket to Harrys Police).
