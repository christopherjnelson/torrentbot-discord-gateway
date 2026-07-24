# Prowlarr search workflows (verified)

Tag legend: `[impl+tests]` = verified by implementation + passing tests;
`[docs 2026-07-19]` = verified against official Prowlarr source on 2026-07-19.

## Discord entry points `[impl+tests]`

- `/search general query:<text>` sends the validated query directly to
  Prowlarr and never calls TMDB.
- A selected `/search movie` or `/search tv` result re-fetches trusted
  canonical metadata, then enters this workflow with
  `<canonical title> <year>` (or title only when year is unavailable).
- `Search exactly as entered` bypasses TMDB details and enters this workflow
  with the original validated query.

All three entry points share the exact normalization, selectable BTIH,
deduplication, cache enrichment, and release-menu path below.

## Discord Prowlarr end-to-end flow `[impl+tests]`

```
Discord /search general query:<text> or validated media continuation
  → validate query (1–200 chars; else ephemeral usage error)
  → authorize guild (TORBOX_ALLOWED_GUILD_IDS; else ephemeral deny)
  → confirm PROWLARR_URL + PROWLARR_API_KEY configured (else ephemeral error)
  → defer ephemerally (Discord type 5, flag 64); run the rest in ctx.waitUntil
  → searchProwlarr(query, { limit: 25 })   [GET /api/v1/search]
  → normalize each release → TorrentResult
  → sortResults (seeders desc, size desc, title asc, stable)
  → buildSelectableOptions(results, SELECT_OPTION_CAP=10):
       keep valid 40-char-hash results → dedup by lowercased hash
       → drop empty/whitespace sanitized labels → first 10
  → enrichWithCacheStatus(selectable)  [advisory TorBox cache check]
  → buildSearchComponents(selectable) → Discord select menu (if signing configured)
  → editOriginalResponse with content + components
```

Implementation: `handleSearchCommand` and `completeSearch` in
`src/commands/search.ts`; `searchProwlarr`/`sortResults` in
`src/services/prowlarr.ts`; `buildSelectableOptions` in
`src/utils/selectable.ts`.

## Prowlarr is the search source `[impl+tests]`

All search results come from Prowlarr `GET /api/v1/search`. The TorBox
Voyager/Torznab search API is **not** used. Prowlarr is queried once per
`/search` invocation; there is no pagination or follow-up query.

## TorBox cache status is advisory enrichment only `[impl+tests]`

`enrichWithCacheStatus` makes a **single best-effort** TorBox
`POST /torrents/checkcached` batch request for the selectable hashes and
sets `isCached = true` on matching results (matched case-insensitively). It
is advisory: it only adds a `⚡ Cached` badge to the Discord option
description. It does **not** add anything to TorBox and does not mutate the
Prowlarr or TorBox account.

## A TorBox cache-check failure must not break search `[impl+tests]`

If TorBox is not configured, or the selectable set is empty, or the
cache-check request fails (HTTP/auth/parse/network/timeout), `enrichWithCacheStatus`
logs a sanitized warning (`logUpstreamFailure("torbox cache check failed", …)`)
and returns, leaving results unchanged (no badges). `/search` still returns
the Prowlarr results and the select menu. The cache check is wrapped in
try/catch and never rethrows to the caller.

## Prowlarr search does not mutate Prowlarr or TorBox `[impl+tests]`

`/search` performs a single read-only GET to Prowlarr. No torrent is
submitted to TorBox during search. TorBox mutation happens **only** when a
user later selects a result from the menu (the component interaction flow in
`src/commands/component.ts`, documented in the TorBox skill).

## Result limit handling `[impl+tests]`

- Discord `/search` requests 25 releases from Prowlarr
  (`PROWLARR_REQUEST_LIMIT = 25` in `src/commands/search.ts`) to provide
  headroom for duplicates, invalid hashes, and empty labels.
- The Discord select menu is capped at 10 options
  (`SELECT_OPTION_CAP = 10` in `src/utils/signing.ts`,
  `MAX_SEARCH_RESULTS = 10` in `src/commands/search.ts`).
- `buildSelectableOptions` scans the Prowlarr results and keeps the first
  10 valid, deduplicated, non-empty-label releases. The service clamps any
  `limit` to 1–100 (`DEFAULT_LIMIT=25`, `MAX_LIMIT=100`).
- The selectable set can be fewer than 10 (dedup, empty-label, invalid-hash
  filtering) or zero.
- Internal `/api/search` route: default limit 5, max 25
  (`DEFAULT_SEARCH_LIMIT`/`MAX_SEARCH_LIMIT` in `src/routes/api.ts`).

## Deterministic ordering `[impl+tests]`

`sortResults` (in `src/services/prowlarr.ts`): seeders desc → size desc →
title asc (localeCompare) → original index (stable tiebreak). `null`
seeders/size sort as -1 (last). This is the app's sort, not a Prowlarr
guarantee.

## Timeout behavior `[impl+tests]`

Each Prowlarr request uses `config.upstreamTimeoutMs` (default 10000ms,
range 1–60000). A stall past the timeout throws `UpstreamTimeoutError`,
surfaced to the user as a friendly "took too long" message. Tests cover a
delayed-response timeout.

## Failure and fallback behavior `[impl+tests]`

| Failure | Result to user |
| --- | --- |
| Invalid/missing query | ephemeral usage message (no Prowlarr call) |
| Guild not authorized | ephemeral deny message (no Prowlarr call) |
| Prowlarr not configured | ephemeral "not configured" (no call) |
| Invalid base URL | `ConfigError` → friendly error |
| HTTP 401 (bad key) | `UpstreamStatusError` → "rejected credentials" |
| Other non-200 | `UpstreamStatusError` → generic upstream error |
| Invalid/non-array JSON | `UpstreamParseError` → generic upstream error |
| Timeout | `UpstreamTimeoutError` → "took too long" |
| Empty results (`[]`) | "No results found for \`<query>\`." |
| Results but none selectable | results message, no select menu |
| Final Discord edit rejected | logged via `logDiscordApiFailure`; search still "succeeded" |

All upstream errors are funneled through `logUpstreamFailure` + `upstreamErrorMessage`
(`src/commands/shared.ts`), which log only the error class name and show a
sanitized user message.

## Internal `/api/search` route `[impl+tests]`

`POST /api/search` (`src/routes/api.ts`) requires `Authorization: Bearer
$INTERNAL_API_TOKEN`, accepts `{ query, limit? }` (query 1–200 chars, limit
1–25 default 5), and returns the same normalized `TorrentResult[]` — but
**includes** `magnetUri` in the response (authenticated server-to-server
traffic), unlike Discord. No TorBox cache enrichment is performed on this
route. No select menu is built.
