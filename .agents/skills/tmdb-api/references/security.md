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
  re-fetched and normalized before Prowlarr is called; TV season selections
  are additionally checked against the re-fetched normalized season list.
  `[impl+tests]`
- Season page custom IDs and option values are separately HMAC-bound to the
  requester, expiry, series ID, page, and original-query digest. They contain
  no title, query, or season list. `[impl+tests]`
- The exact-search fallback does not make an additional TMDB details request.
  `[impl+tests]`
Media artwork is accepted only as a normalized TMDB poster file path and is
rendered from the fixed HTTPS `image.tmdb.org` origin. Full provider-supplied
URLs, traversal, query strings, nested paths, and malformed values are rejected.
Poster URLs are never downloaded, proxied, cached, persisted, or logged.
