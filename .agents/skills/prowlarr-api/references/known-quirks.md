# Prowlarr known quirks, limitations, and uncertainties

Tag legend: `[impl+tests]` = verified by implementation + tests;
`[docs 2026-07-19]` = verified against official Prowlarr source on 2026-07-19;
`[uncertain]` = documented limitation/uncertainty — do not rely on as fact.

## Same torrent across multiple indexers `[impl+tests]`

The same torrent may be returned by multiple indexers, producing multiple
release entries with the **same info hash**. Prowlarr search returns all of
them; the selectable-set step (`buildSelectableOptions`) deduplicates by the
**lowercased** info hash, keeping the first occurrence in sorted order.

## Duplicate normalized info hashes `[impl+tests]`

Dedup happens **after** sorting and **after** the Prowlarr request, in
`getSelectableResults` (`src/utils/selectable.ts`). Only results with a valid
40-char hex hash are deduplicated; results with no/invalid hash are not
selectable at all.

## Missing/inconsistent seeders, size, source `[impl+tests]`

`seeders`, `size`, and `indexer` (source) are all optional. Any missing or
non-non-negative-integer value degrades to `null` (never a placeholder like
0 or "unknown"). Sorting treats `null` seeders/size as -1 (sorts last).

## Missing magnet but available hash `[impl+tests]`

When `magnetUrl` is absent or is a proxy URL (not starting with `magnet:`)
but a valid `infoHash` is present, a bare magnet
`magnet:?xt=urn:btih:${infoHash}` is synthesized. This is a valid magnet URI
accepted by TorBox's `createtorrent`.

## Missing or malformed info hash `[impl+tests]`

A result with a title but no/invalid `infoHash` is kept in the normalized
results (so it can appear in `/api/search` output) but is **excluded** from
the Discord selectable menu, which requires `isValidInfoHash`
(40-char hex). It is also excluded from the TorBox cache-check batch.

## `magnetUrl` is usually a proxy URL, not a real magnet `[impl+tests]` `[docs 2026-07-19]`

Prowlarr source documents that `SearchController.MapReleases` rewrites
`magnetUrl`/`downloadUrl` into proxy URLs embedding the API key. The repo
therefore only trusts a `magnetUrl` that begins with `magnet:`. Whether a
given indexer/instance ever returns a raw `magnet:` URI in `magnetUrl` is
`[uncertain]`; the code handles both cases.

## Category ambiguity `[impl+tests]`

Only the **first** valid category id is kept. `categories` may be an array of
`{id, name}` objects or (tolerated) bare numbers; a non-array or empty array
yields `categoryId: null`. The app does not filter by category — the value is
displayed only.

## NZB / Usenet results are not supported `[uncertain]`

This app is BitTorrent/BTIH-only: selectable results require a 40-char hex
info hash, and magnets are BTIH magnets. NZB/Usenet releases (which lack a
BTIH hash) would be normalized (if they have a title) but would never be
selectable and never feed TorBox. Whether NZB results actually appear given
`type=search` is `[uncertain]` — not confirmed against a live instance. Do
not claim NZB support.

## Ordering is deterministic but not a quality guarantee `[impl+tests]` `[uncertain]`

Results are sorted deterministically: seeders (desc) → size (desc) → title
(asc) → original index (stable tiebreak). This is the app's own sort
(`sortResults`), **not** a Prowlarr guarantee. Whether seeders-first is a
reliable quality proxy is `[uncertain]`; it is an assumption, not a contract.

## Parse cap independent of limit `[impl+tests]`

`MAX_PARSED_RELEASES = 100` caps how many entries are normalized from one
response, regardless of the requested `limit`. If Prowlarr returns more than
100 entries, only the first 100 are considered. This is a defensive bound,
not a Prowlarr limit.

## Result count vs selectable count `[impl+tests]`

The Discord `/search` requests `limit: 5` from Prowlarr
(`MAX_SEARCH_RESULTS`), and the Discord menu is capped at 5 options
(`SELECT_OPTION_CAP`). These are **separate** constants that happen to both
be 5. The selectable count can be fewer than 5 (after dedup, empty-label
filtering, and invalid-hash exclusion) or zero. The internal `/api/search`
route uses a different limit range (default 5, max 25).

If you confirm any `[uncertain]` item with a live instance or official docs,
update this file and the verification date, and change the tag to
`[impl+tests]` or `[docs 2026-07-19]` as appropriate.
