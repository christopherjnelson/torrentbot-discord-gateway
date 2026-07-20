# TorBox known quirks, limitations, and uncertainties

Tag legend: `[impl+tests]` = verified by implementation + tests;
`[docs 2026-07-20]` = verified against official docs on 2026-07-20;
`[uncertain]` = documented limitation/uncertainty — do not rely on as fact.

## ITEM_NOT_FOUND quirk `[impl+tests]`

A missing torrent is reported by TorBox as **`success: true`** with
`error: "ITEM_NOT_FOUND"` and `data: null`, **or** as HTTP 404 (possibly with
a non-JSON body). The client normalizes **both** to `null` in
`getTorrentById`, and `findTorrentByHash` catches the `ITEM_NOT_FOUND`
`UpstreamApiError` from `listTorrents` and returns `null`. Any new
not-found path must preserve this "quirky success:true + 404 → null"
normalization.

## Duplicate quirk `[impl+tests]`

`DUPLICATE_ITEM` arrives as a **standard envelope with `success: false`**
(`error: "DUPLICATE_ITEM"`, `detail: "This item already exists."`,
`data: null`) rather than a non-200 status. The client surfaces it as
`UpstreamApiError` with `code: "DUPLICATE_ITEM"`. The selection flow recovers
by re-listing and matching by info hash (see `torrent-workflows.md` §2),
because `createtorrent` does not return the existing torrent's id on
duplicate.

## mylist shape duality `[docs 2026-07-20]` `[impl+tests]`

`GET /torrents/mylist` without `id` returns `data` as an **array**; with
`id` the docs state it "will return an object rather than list". The client
tolerates **both** shapes for the `id` case (and even an array when
expecting one). Do not assume a single shape.

## 600-second list cache `[docs 2026-07-20]` `[impl+tests]`

`mylist` list data is cached server-side for 600 seconds. Any code reading
fresh readiness state **must** send `bypass_cache=true` (the client does this
in `getTorrentById` and `findTorrentByHash`). Without it, polling can see
stale `download_finished` values.

## `download_state: "completed"` is not readiness `[docs 2026-07-20]` `[impl+tests]`

The docs explicitly say `download_state: "completed"` must **not** be used
for download-completion status; use `download_finished === true` instead.
The test suite asserts a `completed` state with `download_finished: false`
is **not** ready.

## Bounded polling limitations `[impl+tests]`

Polling is bounded to ~15–20s by default (`TORBOX_POLL_MAX_ATTEMPTS` = 7,
`TORBOX_POLL_INTERVAL_MS` = 2500; ranges 1–20 and 250–10000 respectively).
Outcomes other than "ready": `processing` (budget exhausted) or `not-found`
(seen then vanished). The bot does **not** persist state and does **not**
notify the user later; `/status` is the fallback. Persistent monitoring is
out of scope.

## `requestdl` token in the URL `[docs 2026-07-20]` `[impl+tests]`

`requestdl` is the only endpoint requiring the API key in the URL (`token`
query param). Because of this, request URLs are never logged. The
`redirect=true` permalink form embeds the key permanently and is never used.

## Remaining uncertainties

- **`mylist` `progress` range** `[uncertain]` — not yet confirmed against a
  live API key whether `progress` is 0–1 or 0–100. The README notes the bot
  normalizes both (`<= 1` is treated as a fraction) via `progressPercent`.
  Do not assume either range without verifying.
- **`download_state: "completed"` vs `download_finished: true`** `[uncertain]`
  — not yet confirmed whether they ever diverge in practice. The bot relies
  only on `download_finished` regardless, so this is informational.
- **`auth_id` semantics** — modelled and returned but not used by any
  workflow; its exact meaning beyond "create-torrent echo" is not relied
  upon. `[uncertain]`

If you confirm any `[uncertain]` item with a real API key or official docs,
update this file and the verification date, and change the tag to
`[impl+tests]` or `[docs 2026-07-20]` as appropriate.
