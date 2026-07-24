# TMDB known quirks and limitations

- Missing/empty/malformed dates yield `Year unknown`; canonical Prowlarr
  search then omits the year. `[impl+tests]`
- Repeated search IDs are deduplicated with first occurrence winning.
  `[impl+tests]`
- Malformed individual entries are skipped, but a malformed top-level
  response fails the lookup. `[impl+tests]`
- TorrentBot uses translated `title`/`name` as canonical and does not append
  `original_title`/`original_name` to Prowlarr queries. `[impl+tests]`
- No explicit `language` parameter is sent, so the provider default applies.
  `[docs 2026-07-24]`
- Live ranking quality and rate-limit headers have not been verified with a
  production credential. The app preserves upstream order and normalizes
  HTTP 429 without depending on headers. `[uncertain]`
