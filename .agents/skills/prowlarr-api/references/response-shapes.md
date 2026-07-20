# Prowlarr response shapes (only fields this repo reads/models)

All examples are **synthetic** (not real data). Tag legend:
`[impl+tests]` = verified by implementation + tests;
`[docs 2026-07-19]` = verified against official Prowlarr source on 2026-07-19.

## Upstream: `ReleaseResource` (JSON array element) `[impl+tests]` `[docs 2026-07-19]`

Prowlarr's `GET /api/v1/search` returns a JSON **array** of release objects
(camelCase fields, per `ReleaseResource.cs`). Only these fields are read:

| Upstream field | Type | Used for | When null/missing |
| --- | --- | --- | --- |
| `title` | string | `TorrentResult.title` (trimmed) | entry **dropped** (returns null) |
| `size` | number | `TorrentResult.sizeBytes` | → `null` |
| `seeders` | number | `TorrentResult.seeders` | → `null` |
| `leechers` | number | `TorrentResult.peers` (= seeders + leechers) | → `null` (peers also null) |
| `infoHash` | string | `TorrentResult.infoHash` | → `null` |
| `magnetUrl` | string | `TorrentResult.magnetUri` (see magnet handling) | → synthesized/null |
| `categories` | array | `TorrentResult.categoryId` (first id) | → `null` |
| `indexer` | string | `TorrentResult.source` | → `null` |
| `infoUrl` | string | `TorrentResult.link` | → `null` |
| `publishDate` | string | `TorrentResult.publishedAt` | → `null` |

**Deliberately ignored:** `downloadUrl` and any other field. Prowlarr
rewrites `downloadUrl`/`magnetUrl` into proxy URLs (`/{indexerId}/download?…`)
that embed the API key; those fields are never propagated, logged, or
displayed. `[impl+tests]` (The proxy-URL behavior itself is documented in
Prowlarr source; the repo's defense against it is `[impl+tests]`.)

## Categories `[impl+tests]`

`categories` is expected to be an array of `{ id, name, … }` objects
(Newznab `IndexerCategory`). Bare numeric ids are tolerated as a fallback.
Only the **first** valid id is kept (`categoryId`); the rest are ignored.
A non-array or empty array → `categoryId: null`.

## Normalized: `TorrentResult` (`src/types/search.ts`) `[impl+tests]`

| Field | Type | Derivation |
| --- | --- | --- |
| `title` | `string` | `value.title` trimmed; entry dropped if empty |
| `sizeBytes` | `number \| null` | `asNonNegativeInt(value.size)` |
| `seeders` | `number \| null` | `asNonNegativeInt(value.seeders)` |
| `peers` | `number \| null` | `seeders + leechers` when both non-null, else `null` |
| `categoryId` | `number \| null` | first valid id from `categories` |
| `source` | `string \| null` | `value.indexer` |
| `link` | `string \| null` | `value.infoUrl` (never a proxy/download URL) |
| `infoHash` | `string \| null` | `value.infoHash` (case preserved) |
| `magnetUri` | `string \| null` | see magnet handling below |
| `publishedAt` | `string \| null` | `value.publishDate` |
| `isCached?` | `boolean \| undefined` | set later by TorBox cache enrichment, never by Prowlarr search |

## Info-hash normalization `[impl+tests]`

- **Valid BTIH format:** `/^[a-fA-F0-9]{40}$/` — 40 hexadecimal characters
  (`isValidInfoHash` in `src/utils/signing.ts`).
- The normalized `TorrentResult.infoHash` preserves the upstream case
  (Prowlarr may send uppercase, e.g. `0123456789ABCDEF…`).
- Lowercasing is applied **only** as the dedup key and the TorBox cache-match
  key, never to the stored `infoHash` value.
- A missing/malformed hash does not drop the result (if it has a title); it
  just sets `infoHash: null`, and the result is later excluded from the
  selectable menu (which requires a valid hash).

## Magnet handling (defensive) `[impl+tests]`

The repo does **not** assume `magnetUrl` is always a real magnet. The rule:

1. If `value.magnetUrl` is a string that **begins with `magnet:`**, it is
   passed through as `TorrentResult.magnetUri`.
2. Otherwise, if a valid BTIH `infoHash` is present, a bare magnet is
   **synthesized**: `magnet:?xt=urn:btih:${infoHash}`.
3. Otherwise `magnetUri` is `null`.

Credential-bearing proxy URLs (anything not starting with `magnet:`) are
never propagated. This is the repository's defensive behavior; the skill does
not claim every Prowlarr instance always returns proxy URLs — only that this
code defends against that case.

## Synthetic example (upstream)

```json
[
  {
    "title": "Example.Release.1080p-GROUP",
    "size": 1468006400,
    "seeders": 120,
    "leechers": 20,
    "infoHash": "89abcdef012345670123456789abcdef01234567",
    "magnetUrl": "https://prowlarr.example/2/download?apikey=REDACTED&link=BBB&file=t",
    "categories": [{ "id": 2030, "name": "Movies HD" }],
    "indexer": "ExampleTracker",
    "infoUrl": "https://indexer.example/details/bbb",
    "publishDate": "2025-02-02T08:30:00Z"
  }
]
```

→ normalized `{ title: "Example.Release.1080p-GROUP", sizeBytes: 1468006400,
seeders: 120, peers: 140, categoryId: 2030, source: "ExampleTracker",
link: "https://indexer.example/details/bbb",
infoHash: "89abcdef012345670123456789abcdef01234567",
magnetUri: "magnet:?xt=urn:btih:89abcdef…", publishedAt: "2025-02-02T08:30:00Z" }`
(magnet synthesized because `magnetUrl` did not start with `magnet:`).

## Malformed-shape behavior `[impl+tests]`

| Input | Result |
| --- | --- |
| Top-level not a JSON array | `UpstreamParseError` |
| Invalid JSON | `UpstreamParseError` |
| Entry not an object (`null`, number, string) | skipped |
| Entry with no/empty/whitespace `title` | skipped (returns null) |
| Entry with only `title` | kept; all other fields `null` |
| Entry with `title` but no `infoHash` | kept; `infoHash: null`, `magnetUri: null` |
