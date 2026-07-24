# TorBox security rules

These rules are enforced by `src/services/torbox.ts` and must be preserved by
any change. Tag legend: `[impl+tests]` = verified by implementation + tests;
`[docs 2026-07-20]` = verified against official docs on 2026-07-20.

## Where credentials travel

| Endpoint | API key location | Notes |
| --- | --- | --- |
| all endpoints | `Authorization: Bearer <key>` header | `[impl+tests]` |
| `requestdl` only | **also** the `token` query parameter | required by docs; the request URL therefore contains the key `[docs 2026-07-20]` `[impl+tests]` |

Because `requestdl` puts the key in the URL, **request URLs are never logged**.
The `fetchText` helper and the normalized `Upstream*` error types never carry
URLs. `[impl+tests]`

## What must NEVER be logged, echoed, or embedded in errors

Enforced at the TorBox client boundary and by the command-layer helpers
(`logUpstreamFailure` / `logDiscordApiFailure` in `src/commands/shared.ts`):

- TorBox API keys and `Authorization` headers. `[impl+tests]`
- The `requestdl` `token` query parameter (it is the API key). `[impl+tests]`
- Full magnet URIs — accepted as input only; the magnet is submitted to
  TorBox and never echoed to Discord or written to logs. `[impl+tests]`
- Info hashes treated as secrets in logs (hashes are non-sensitive
  identifiers in the TorBox request body, but the client never logs them;
  Discord output shows only *availability markers*, not the hash itself). `[impl+tests]`
- Generated temporary download URLs — returned to the requester in an
  ephemeral message only; never logged, never persisted, never placed in the
  public search-results message. `[impl+tests]`

The guided search flow places that validated HTTPS URL only in the final
ephemeral Discord link button; stale release controls are removed before
TorBox processing begins. `[impl+tests]`
- Raw upstream request URLs and response bodies — only the sanitized
  `detail` (≤200 chars) and the `error` code are surfaced. `[impl+tests]`

## Boundary error types `[impl+tests]`

The TorBox client throws only:

- `UpstreamApiError` — `{ service, message(detail), code, status }`,
- `UpstreamStatusError` — `{ service, status }`,
- `UpstreamParseError` — `{ service, message }`,
- `UpstreamTimeoutError` — `{ service }`.

None of these carry URLs, hashes, magnets, or credentials. Preserve this:
any new TorBox error path must surface one of these types, not a raw
`Error` containing upstream text.

## HTTPS-only download URLs `[impl+tests]`

`requestDownloadLink` rejects any returned URL whose protocol is not `https:`
(`UpstreamParseError`). The documented `redirect=true` permalink form — which
**embeds the API key permanently in the URL** — is deliberately never used.
Only the temporary `https:` CDN link is accepted.

## Discord-side exposure `[impl+tests]`

- All bot messages set `allowed_mentions: { parse: [] }`; titles are sanitized
  and length-capped.
- Magnet/hash **availability markers** may appear in Discord output; actual
  magnet URIs are exposed **only** through the authenticated internal API
  (`/api/search`), never through Discord.
- Component option values and `custom_id`s are treated as untrusted input and
  validated (40-char hex) before use.
