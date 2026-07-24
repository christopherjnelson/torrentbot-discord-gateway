# TMDB security rules

- `TMDB_READ_ACCESS_TOKEN` is a Worker secret read only through `env`; no
  tracked file contains a value. `[impl+tests]`
- Authentication is Bearer-only. The token never enters request URLs,
  component fields, errors, Discord content, or logs. `[impl+tests]`
  `[docs 2026-07-24]`
- Request URLs, authorization headers, upstream bodies, raw queries, and
  selected titles are never logged. Logs contain safe operation/category
  metadata only. `[impl+tests]`
- Provider failure content and stack traces never reach Discord. Media lookup
  failures use a generic unavailable message. `[impl+tests]`
- Custom IDs are HMAC-SHA-256 signed, requester-bound, expiring, and at most
  100 characters. Option fields are bounded and mention parsing is disabled.
  `[impl+tests]`
- A numeric selection never supplies trusted canonical metadata. Details are
  re-fetched and normalized before Prowlarr is called. `[impl+tests]`
- The exact-search fallback does not call TMDB details. `[impl+tests]`
