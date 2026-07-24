# TMDB endpoints used

Base: `https://api.themoviedb.org/3` (HTTPS only). `[impl+tests]`

| Operation | Method/path | Parameters | Verified |
| --- | --- | --- | --- |
| Movie search | `GET /search/movie` | `query`, `include_adult=false`, `page=1` | `[docs 2026-07-24]` `[impl+tests]` |
| TV search | `GET /search/tv` | `query`, `include_adult=false`, `page=1` | `[docs 2026-07-24]` `[impl+tests]` |
| Movie details | `GET /movie/{movie_id}` | positive numeric path ID | `[docs 2026-07-24]` `[impl+tests]` |
| TV details | `GET /tv/{series_id}` | positive numeric path ID; canonical series metadata and embedded season summaries | `[docs 2026-07-24]` `[impl+tests]` |

All requests send `Accept: application/json` and
`Authorization: Bearer <TMDB_READ_ACCESS_TOKEN>`. The token is never a query
parameter. `[docs 2026-07-24]` `[impl+tests]`

The adapter uses the shared bounded upstream timeout. Non-200 statuses become
`UpstreamStatusError`; invalid JSON/shape becomes `UpstreamParseError`;
timeouts/network failures become their normalized `Upstream*` types.
`[impl+tests]`

No discover, multi-search, credits, image, season-details, episode, or
authentication session endpoint is used. TV season choices come from the
`seasons` array already embedded in the series-details response; there is no
request per season. `[docs 2026-07-24]` `[impl+tests]`
