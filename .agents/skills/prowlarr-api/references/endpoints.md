# Prowlarr endpoints used by this repository

Base URL: the origin of the user-controlled Prowlarr instance
(`PROWLARR_URL`, e.g. `https://prowlarr.example.com`); the path is resolved
with `new URL("/api/v1/search", baseUrl)` in `src/services/prowlarr.ts`.
`[impl+tests]` = verified by implementation + passing tests;
`[docs 2026-07-19]` = verified against official Prowlarr source/docs on
2026-07-19.

| Endpoint | Method | Path | Auth | Verified |
| --- | --- | --- | --- | --- |
| Search | GET | `/api/v1/search` | `X-Api-Key: <key>` header | `[impl+tests]` `[docs 2026-07-19]` |

## Parameters

| Param | Required? | Sent by this app? | Notes | Verified |
| --- | --- | --- | --- | --- |
| `query` | yes (by the app) | yes | URL-encoded via `URL.searchParams` | `[impl+tests]` |
| `type` | no | yes, always `"search"` | hardcoded | `[impl+tests]` `[docs 2026-07-19]` |
| `limit` | no | yes | clamped to 1–100 (`DEFAULT_LIMIT=25`, `MAX_LIMIT=100`); `/search` sends 5, `/api/search` sends 5–25 | `[impl+tests]` `[docs 2026-07-19]` |
| `offset` | no | **no** | documented but unused | `[docs 2026-07-19]` |
| `indexerIds` | no | **no** | documented but unused | `[docs 2026-07-19]` |
| `categories` | no | **no** | documented but unused | `[docs 2026-07-19]` |

A request also sends `Accept: application/json`. The API key travels **only**
in the `X-Api-Key` header, never in the URL. `[impl+tests]`

## Response and error behavior

| Outcome | Behavior | Verified |
| --- | --- | --- |
| HTTP 200 + JSON array | Normalize each entry (see `response-shapes.md`); sort; cap to `limit`. | `[impl+tests]` |
| HTTP 200 + non-array JSON | `UpstreamParseError` ("returned an unexpected JSON structure") | `[impl+tests]` |
| HTTP 200 + invalid JSON | `UpstreamParseError` ("returned invalid JSON") | `[impl+tests]` |
| HTTP 401 | `UpstreamStatusError` (missing/invalid API key) | `[impl+tests]` `[docs 2026-07-19]` |
| Any other non-200 | `UpstreamStatusError(service, status)` | `[impl+tests]` |
| Network timeout | `UpstreamTimeoutError` (per-request `timeoutMs`) | `[impl+tests]` |
| Invalid base URL | `ConfigError("PROWLARR_URL is not a valid URL")` before any request | `[impl+tests]` |

No error type carries the API key, request URL, or response payload.
`[impl+tests]`

## Implementation reference

- `searchProwlarr(query, options)` in `src/services/prowlarr.ts`.
- Callers: `completeSearch` in `src/commands/search.ts` (Discord `/search`),
  the `/api/search` handler in `src/routes/api.ts`.

## Endpoints deliberately NOT used

Only `/api/v1/search` is called. No other Prowlarr endpoint (indexer
management, notifications, history, etc.) is used by this Worker.
`/ping` is mentioned in the README as a manual liveness check only; the app
does not call it programmatically. `[impl+tests]`
