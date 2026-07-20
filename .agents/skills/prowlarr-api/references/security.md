# Prowlarr security rules

These rules are enforced by `src/services/prowlarr.ts` and must be preserved
by any change. Tag legend: `[impl+tests]` = verified by implementation +
tests; `[docs 2026-07-19]` = verified against official Prowlarr source on
2026-07-19.

## API key handling `[impl+tests]` `[docs 2026-07-19]`

- The Prowlarr API key travels **only** in the `X-Api-Key` request header.
  It is never placed in the request URL or a query parameter.
- The header is never logged. Tests assert the key does not appear in the
  request path and is not leaked through error messages.
- The key is read from the `PROWLARR_API_KEY` secret. When it is empty/unset,
  the Discord `/search` command fails closed with an ephemeral "not
  configured" message before any Prowlarr call.

## Credential-bearing proxy URLs (defensive) `[impl+tests]`

Prowlarr may rewrite `downloadUrl`/`magnetUrl` in search responses into
proxy URLs of the form `/{indexerId}/download?…` that embed the API key
(documented in Prowlarr source: `SearchController.MapReleases` +
`DownloadMappingService`). The repository defends against this precisely:

- `downloadUrl` is **never read**.
- `magnetUrl` is accepted **only** when it begins with `magnet:`; anything
  else (including a proxy URL) is ignored.
- When `magnetUrl` is not a real magnet and a valid BTIH `infoHash` is
  present, a bare magnet is synthesized from the hash.
- `TorrentResult.link` uses the un-proxied `infoUrl` (the indexer details
  page), never `downloadUrl`.
- Tests assert the serialized results never contain `apikey=`, `/download?`,
  or the test API key.

The skill does **not** claim every Prowlarr instance always returns proxy
URLs — only that this code defends against that case so a credential-bearing
URL can never propagate.

## No raw upstream response logging `[impl+tests]`

The response body is parsed and discarded; it is never logged. Error types
never carry request URLs or response payloads.

## Boundary error types `[impl+tests]`

The Prowlarr adapter throws only:

- `ConfigError` — invalid `PROWLARR_URL` (no network call made).
- `UpstreamStatusError` — non-200 HTTP (including 401 for a bad key).
- `UpstreamParseError` — invalid JSON or a non-array top-level shape.
- `UpstreamTimeoutError` — per-request timeout exceeded.
- `UpstreamNetworkError` — network-level failure.

None of these carry the API key, request URL, or response payload. Preserve
this: any new Prowlarr error path must surface one of these types, not a raw
`Error` containing upstream text.

## Discord-visible sanitization `[impl+tests]`

- Magnet URIs and info hashes never appear in Discord message **content**.
  Discord output shows only availability markers (e.g. a select menu exists
  when valid hashes are present), not the hash itself.
- Titles and sources are sanitized (`sanitizeInline`) and length-capped
  before Discord rendering.
- All bot messages set `allowed_mentions: { parse: [] }`.
- The synthesized magnet is submitted to TorBox **only** when a user later
  selects a result; it is never echoed in `/search` output.

## Base URL validation `[impl+tests]`

`PROWLARR_URL` is parsed with `new URL("/api/v1/search", baseUrl)`. An
invalid URL throws `ConfigError("PROWLARR_URL is not a valid URL")` before
any network call. There is no scheme allow-list beyond what `URL` accepts;
the README documents the instance as HTTPS.

## No secrets in fixtures or docs `[impl+tests]`

Test fixtures use obviously synthetic values (`test-prowlarr-key`,
`https://prowlarr.test`, fake hashes like
`89abcdef012345670123456789abcdef01234567`). No real API keys, real hashes,
real magnets, or real guild/user IDs appear in tracked files. This skill
follows the same rule.
