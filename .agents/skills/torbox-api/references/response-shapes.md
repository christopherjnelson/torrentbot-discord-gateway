# TorBox response shapes (only fields this repo models)

All examples below are **synthetic** (not real data). Tag legend:
`[impl+tests]` = verified by implementation + tests;
`[docs 2026-07-20]` = verified against official docs on 2026-07-20.

## Standard envelope `[impl+tests]` `[docs 2026-07-20]`

Every endpoint returns:

```json
{ "success": true, "error": null, "detail": "...", "data": <T> }
```

- `success: boolean` — required; the client treats `success !== true` (on
  HTTP 200) as a failure.
- `error: string | null` — machine-readable code on failure (e.g.
  `"DUPLICATE_ITEM"`, `"ITEM_NOT_FOUND"`), else `null`.
- `detail: string` — user-facing message; sanitized to 200 chars before use.
- `data: T` — endpoint-specific; may be `null` on some failures.

The client (`parseEnvelope` in `src/services/torbox.ts`) throws
`UpstreamParseError` on invalid JSON or a non-boolean `success`.

## POST /torrents/createtorrent — `data` `[impl+tests]`

```json
{ "hash": "abc123hash", "torrent_id": 42, "auth_id": "auth-x" }
```

Modelled as `TorboxCreateTorrentData` (`src/types/torbox.ts`):
`hash: string`, `torrent_id: number`, `auth_id: string` (defaults to `""`
if absent). The client requires `torrent_id` and `hash` to be present or it
throws `UpstreamParseError`.

**Duplicate failure** (still the standard envelope, but `success: false`):

```json
{ "success": false, "error": "DUPLICATE_ITEM",
  "detail": "This item already exists.", "data": null }
```

→ thrown as `UpstreamApiError` with `code: "DUPLICATE_ITEM"`. `[impl+tests]`

## GET /torrents/mylist — torrent object `[impl+tests]`

`data` is an **array** when no `id` is given, or an **object** when `id` is
given (docs: "will return an object rather than list"). The client tolerates
both. Only these fields are modelled (`TorboxTorrent`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | required for normalization |
| `hash` | string | defaults to `""` |
| `name` | string | required for normalization |
| `size` | number | defaults to `0` |
| `active` | boolean | `=== true` |
| `created_at` | string | defaults to `""` |
| `updated_at` | string | defaults to `""` |
| `download_state` | string | defaults to `"unknown"`; **not** a readiness signal (see quirks) |
| `seeds` | number | defaults to `0` |
| `peers` | number | defaults to `0` |
| `progress` | number | defaults to `0`; range not yet confirmed (see quirks) |
| `download_speed` | number | defaults to `0` |
| `upload_speed` | number | defaults to `0` |
| `download_finished` | boolean | `=== true`; **the** readiness signal |
| `download_present` | boolean | `=== true` |
| `cached` | boolean | `=== true` |
| `files` | `TorboxFile[]` | normalized; non-objects dropped |

Upstream also sends `magnet`, `download_path`, `s3_path`, `absolute_path`,
`md5`, `trackers`, etc. These are **deliberately never read, logged, or
returned**. `[impl+tests]`

### File object (`files[]`, `TorboxFile`) `[impl+tests]`

Only `id: number`, `name: string`, `size: number` are modelled. `id` and
`name` are required for normalization; `size` defaults to `0`. Other upstream
file fields (md5, hash, s3_path, opensubtitles_hash) are never read.

### ITEM_NOT_FOUND (single-torrent lookup) `[impl+tests]`

```json
{ "success": true, "error": "ITEM_NOT_FOUND",
  "detail": "No torrents found for this user.", "data": null }
```

May arrive with HTTP 200 (`success: true`) **or** HTTP 404. The client
normalizes both to `null`. See `known-quirks.md`.

## POST /torrents/checkcached — `data` `[impl+tests]` `[docs 2026-07-20]`

With `format=object`, `data` is a **map keyed by hash**; a key present means
cached. Uncached/unknown hashes are simply absent. The documented "Success
Uncached" example returns `data: null` (nothing cached).

```json
{ "success": true, "error": null,
  "detail": "Torrent cache status retrieved successfully.",
  "data": { "0123456789abcdef0123456789abcdef01234567": true } }
```

The client also tolerates the `list` shape (`data` is an array of
`{ hash }` entries), `null`, and malformed entries (skipped) — all normalized
to a `Set<string>` of **lowercased** cached hashes. An unexpected shape is
treated as "no cached hashes" rather than failing (cache status is advisory).

## GET /torrents/requestdl — `data` `[impl+tests]` `[docs 2026-07-20]`

`data` is a **temporary CDN URL string** (valid ~3 hours for starting a
download):

```json
{ "success": true, "error": null,
  "detail": "Torrent download requested successfully.",
  "data": "https://tb-cdn.example/dld/11111111-2222-3333-4444-555555555555?token=abc" }
```

The client requires `data` to be a non-empty string, parses it as a URL, and
**rejects any non-`https:` protocol** as `UpstreamParseError`. The URL is
returned to the caller but never logged.
