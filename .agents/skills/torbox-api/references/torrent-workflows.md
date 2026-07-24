# TorBox workflows (verified)

Tag legend: `[impl+tests]` = verified by implementation + passing tests;
`[docs 2026-07-20]` = verified against official docs on 2026-07-20.

## Authentication `[impl+tests]` `[docs 2026-07-20]`

All endpoints use `Authorization: Bearer <TORBOX_API_KEY>`. The API key is
read from the `TORBOX_API_KEY` secret. `requestdl` additionally requires the
key as a `token` query parameter (see Security). When `TORBOX_API_KEY` is
empty/unset, the Discord commands fail closed with an ephemeral "not
configured" message and the cache check is skipped entirely. `[impl+tests]`

## Standard envelope handling `[impl+tests]`

Every response is parsed into `{ success, error, detail, data }`. On
non-200 HTTP or `success !== true`, the client throws `UpstreamApiError`
(carrying `status`, `code = error`, sanitized `detail`) when an envelope is
present, or `UpstreamStatusError` (service + status) when the body is not
JSON. These are the **only** error types callers see — they never carry URLs,
hashes, or credentials.

## 1. Create torrent from magnet `[impl+tests]`

`createTorrent(magnetUri, { apiKey, timeoutMs })` → `POST /torrents/createtorrent`
with a multipart form whose single field is `magnet`. On success returns
`{ hash, torrent_id, auth_id }`. Callers (`/add`, the selection flow, the
internal `/api/torrents` route) validate the magnet with `isValidMagnetUri`
before calling.

## 2. Duplicate torrent handling `[impl+tests]`

If `createtorrent` returns `DUPLICATE_ITEM` (`UpstreamApiError`,
`code: "DUPLICATE_ITEM"`), the selection flow (`src/commands/component.ts`)
does **not** fail. It recovers by locating the existing torrent by its info
hash (the stable documented identifier — never by title):

1. `findTorrentByHash(selectedHash, …)` lists the account torrents with
   `bypass_cache=true` and case-insensitively matches the hash.
2. If found, it continues with that torrent's `id` and a heading of
   "Already on TorBox."
3. If the lookup itself fails, or no match is found, it returns a friendly
   ephemeral message directing the user to `/status`.

`/add` and the internal `/api/torrents` route instead surface a friendly
"already on your TorBox account" / 409 message without the recovery step.

## 3. List / get torrent behavior `[impl+tests]`

- `listTorrents({ id?, limit?, offset?, bypassCache? })` →
  `GET /torrents/mylist`. Without `id`, `data` must be an array (else
  `UpstreamParseError`). With `id`, the docs return an object; the code
  tolerates both.
- `getTorrentById(id, …)` → `GET /torrents/mylist?id=<id>&bypass_cache=true`
  (always fresh). Tolerates object **or** array shape (picks the entry whose
  `id` matches). Returns `null` on `ITEM_NOT_FOUND` or HTTP 404 or `data: null`.

## 4. Lookup by torrent ID `[impl+tests]`

`getTorrentById` (above). Used by the readiness poll on every attempt.

## 5. Lookup by info hash `[impl+tests]`

`findTorrentByHash(hash, …)` → `listTorrents({ bypassCache: true })` then a
case-insensitive (`toLowerCase()`) match on `torrent.hash`. Returns `null`
when the account list is `ITEM_NOT_FOUND` or no match exists. Used only for
duplicate recovery.

## 6. Readiness polling `[impl+tests]`

`waitForTorrentReady(id, options, poll)` is fully bounded:

- first poll runs immediately after a successful submission;
- up to `maxAttempts` polls, `intervalMs` apart;
- each poll is `getTorrentById` (one upstream call with its own timeout);
- stops as soon as the torrent is **ready**, the budget is exhausted, the
  torrent **disappears after being seen** (→ `not-found`), or an upstream
  error occurs (propagated, stops polling immediately).
- a torrent **never yet seen** (creation still propagating) keeps polling
  within the budget.

Result type `TorrentReadiness`:
`{ status: "ready"; torrent }` | `{ status: "processing"; torrent | null }` |
`{ status: "not-found" }`.

Config (defaults in `src/config.ts`): `TORBOX_POLL_INTERVAL_MS` default
`2500` (range 250–10000), `TORBOX_POLL_MAX_ATTEMPTS` default `7` (range
1–20) → a window of roughly 15–20 seconds.

## 7. `download_finished` readiness rule `[impl+tests]` `[docs 2026-07-20]`

**Readiness = `torrent.download_finished === true`.** This is the only
completion signal used. The official docs explicitly state that
`download_state: "completed"` must **not** be used for download-completion
status. The test "does not treat download_state completed as ready"
(`test/torbox.spec.ts`) asserts that a torrent with
`download_state: "completed"` but `download_finished: false` is **not**
treated as ready.

## 8. Why `download_state: "completed"` is not used `[docs 2026-07-20]`

Per the official TorBox docs, `download_state: "completed"` is documented as
"do not use this for download completion status"; `download_finished` is the
supported completion signal. Whether the two ever diverge in practice is an
`[uncertain]` item (see `known-quirks.md`); the bot relies only on
`download_finished` regardless.

## 9. `bypass_cache=true` during polling `[impl+tests]` `[docs 2026-07-20]`

`getTorrentById` always sets `bypass_cache=true`, and `findTorrentByHash`
lists with `bypass_cache=true`. The official docs note the mylist response is
otherwise cached for 600 seconds, which would return stale readiness state.
Tests assert the `bypass_cache=true` query parameter is sent.

## 10. Torrent cache availability batch checking `[impl+tests]`

`checkTorrentCache(infoHashes, { apiKey })` →
`POST /torrents/checkcached?format=object` with JSON body
`{ hashes: [...] }`. Hashes are lowercased, validated as 40-char hex, and
de-duplicated **before** sending; empty input makes no request and returns an
empty set. One batch request covers up to the ten selectable search results.
Throws `Upstream*` on HTTP/auth/parse failure; the `/search` caller treats it
as advisory (logs a sanitized warning, leaves results without badges).

## 11. Cached vs uncached response behavior `[impl+tests]` `[docs 2026-07-20]`

- **Cached**: the hash is a key present in the `data` map → added to the
  returned `Set` (lowercased).
- **Uncached/unknown**: the hash is simply absent from `data`; the documented
  "Success Uncached" example returns `data: null` (empty set).
- The result set is normalized to lowercase so callers can do a
  case-insensitive `set.has(hash.toLowerCase())` lookup.

## 12. Request download-link generation `[impl+tests]` `[docs 2026-07-20]`

`requestDownloadLink({ apiKey, torrentId, fileId? | zip? })` →
`GET /torrents/requestdl?token=<key>&torrent_id=<id>…`. If `zip === true`
**or** `fileId` is omitted, it sends `zip_link=true`; otherwise it sends
`file_id=<id>`. Per the docs, `zip_link` is "required if no file_id" and
"takes precedence over file_id if both are given". Returns the temporary CDN
URL string. Only `https:` URLs are accepted; anything else is
`UpstreamParseError`.

## 13. Single-file downloads `[impl+tests]`

`selectDownloadTarget(torrent)` is deterministic: **exactly one file** →
`{ kind: "file", file }` and the bot requests `file_id` for that file. The
ephemeral message shows a "Download file" Markdown link followed by the sanitized file name and its size (e.g. `[Download file](<url>) — name (1.4 GiB)`).

## 14. Multi-file ZIP downloads `[impl+tests]`

**Zero or multiple files** → `{ kind: "zip" }` and the bot requests
`zip_link=true` (the documented whole-torrent archive option). The ephemeral
message shows `[Download archive (zip)](<url>)`. This avoids guessing at
individual files inside a multi-file torrent.

Both the selection workflow (`src/commands/component.ts`) and `/status`
(`src/commands/status.ts`) reuse `selectDownloadTarget` and
`requestDownloadLink` for these rules. `/status` shows a concise
`[Download](<url>)` link per ready torrent (up to 10 entries, sequential
best-effort requests); processing torrents are status-only.

## 15. Temporary CDN URLs `[impl+tests]` `[docs 2026-07-20]`

Generated download URLs are temporary CDN links (valid ~3 hours for starting
a download). They are returned only in the **ephemeral** message to the
requester — never in the public search-results message, never logged, never
persisted. Both the selection follow-up and the `/status` ephemeral response
follow this rule.

## 16. HTTPS-only URL validation `[impl+tests]`

`requestDownloadLink` parses `data` as a URL and rejects any protocol other
than `https:` with `UpstreamParseError` ("returned a download link with a
disallowed protocol"). Tests cover the `http://` rejection case.

## 17. Bounded polling limitations `[impl+tests]`

Polling is best-effort and bounded (~15–20s default). If a torrent is not
ready within the window, the bot tells the user it is still processing and
**stops** — it does **not** persist state and does **not** notify the user
later. `/status` is the fallback. Persistent background monitoring (KV, D1,
Durable Objects, Queues, Workflows, cron) is intentionally out of scope.
## Guided Discord presentation `[impl+tests]`

The redesigned search continuation edits one ephemeral interaction response:
release card → processing card → ready/status card. It does not create a
separate followup for the guided path. Ready cards use an HTTPS Discord link
button: exactly one file uses the direct file URL; zero or multiple files use
the ZIP URL. The temporary URL remains unlogged and unpersisted. `/add` and
`/status` contracts are unchanged.
