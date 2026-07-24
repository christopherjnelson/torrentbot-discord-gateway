# tmdb-api

A focused Agent Skill for the TMDB v3 movie/TV disambiguation implemented by
this repository. It documents only the four endpoints, normalized media and
TV-season fields, component continuation, and security behavior TorrentBot
actually uses.

**Verification date:** 2026-07-24. Official-contract statements use
`[docs 2026-07-24]`; repository behavior covered by implementation and tests
uses `[impl+tests]`.

## When to load this skill

Read this skill and all files in `references/` before modifying:

- `src/services/tmdb.ts` or `src/types/media.ts`;
- the movie/TV paths in `src/commands/search.ts`;
- TMDB component handling in `src/commands/media.ts` or
  `src/commands/component.ts`;
- TMDB tests, fixtures, configuration, or README guidance.

## Reference files

| File | Contents |
| --- | --- |
| `references/endpoints.md` | Exact search/details endpoints and authentication |
| `references/response-shapes.md` | Fields read and normalization rules |
| `references/media-workflows.md` | Command, menu, selection, and fallback flows |
| `references/security.md` | Credential, component, logging, and error rules |
| `references/known-quirks.md` | Degraded fields and current limitations |

## Ground rules

1. Do not add unrelated TMDB endpoints or fields. `[impl+tests]`
2. Use `TMDB_READ_ACCESS_TOKEN` only as
   `Authorization: Bearer <token>`; never put it in a URL. `[impl+tests]`
   `[docs 2026-07-24]`
3. Treat all TMDB JSON as untrusted. Validate top-level shapes and normalize
   only the fields documented here. `[impl+tests]`
4. Preserve upstream search order, deduplicate exact IDs, and keep the TMDB
   result cap separate from Prowlarr/Discord caps. `[impl+tests]`
5. Never trust client-supplied title/year/season metadata after selection.
   Re-fetch the official details endpoint by the signed menu's media type and
   selected numeric ID; selected TV seasons must exist in its normalized
   embedded season list. `[impl+tests]`
6. Update this skill whenever a TMDB endpoint, normalized field, auth rule,
   or media workflow changes.

## Authoritative sources

- <https://developer.themoviedb.org/reference/search-movie>
- <https://developer.themoviedb.org/reference/search-tv>
- <https://developer.themoviedb.org/reference/movie-details>
- <https://developer.themoviedb.org/reference/tv-series-details>
- <https://developer.themoviedb.org/docs/authentication-application>
