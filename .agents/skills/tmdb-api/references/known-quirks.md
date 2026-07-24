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
- TV season availability follows the `seasons` array returned by trusted
  series details. TorrentBot does not invent seasons from
  `number_of_seasons`, exclude missing `air_date` values, compare dates, or
  distinguish announced from aired seasons. `[impl+tests]`
- The season UI uses 20-season signed pages. It supports Complete series,
  Specials, and numbered seasons but not individual episodes. `[impl+tests]`
- TMDB season names and air dates are deliberately not retained or displayed;
  fixed labels avoid trusting arbitrary provider strings. `[impl+tests]`
