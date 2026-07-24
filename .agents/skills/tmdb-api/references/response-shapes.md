# TMDB response normalization

Search responses must be an object with a `results` array. Search parses at
most 50 entries, preserves upstream order, removes duplicate numeric IDs, and
returns at most 10 normalized results. `[impl+tests]`

```ts
interface MediaSearchResult {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string | null;
  year: number | null;
  popularity: number | null;
}
```

Movie mapping: `id`, `title`, `original_title`, `release_date`, `popularity`.
TV mapping: `id`, `name`, `original_name`, `first_air_date`, `popularity`.
`[docs 2026-07-24]` `[impl+tests]`

IDs must be positive safe integers. Canonical titles must be non-empty strings;
controls are replaced, whitespace is collapsed, and length is bounded.
Entries without a usable ID/title are dropped. Original titles and
non-negative finite popularity degrade to `null`. `[impl+tests]`

Dates must be real `YYYY-MM-DD` calendar dates. Missing, empty, malformed, or
impossible dates yield `year: null`. Details must return the exact requested
ID. Movie details normalize through `MediaSearchResult`; TV details add:

```ts
interface TvSeasonSummary {
  seasonNumber: number;
  episodeCount: number | null;
}

interface TvDetails extends MediaSearchResult {
  mediaType: "tv";
  seasons: TvSeasonSummary[];
}
```

`GET /tv/{series_id}` supplies `seasons[].season_number` and
`seasons[].episode_count`. Other season fields are not retained because the UI
uses fixed `Specials` / `Season <number>` labels and does not filter by date.
`[docs 2026-07-24]` `[impl+tests]`

The upstream `seasons` field must be an array or it degrades to `[]`. Entries
must be objects with a finite non-negative safe-integer `season_number`;
malformed, negative, fractional, and non-finite numbers are dropped. Duplicate
numbers keep the first valid occurrence, results sort numerically ascending,
and season 0 represents Specials. `episode_count` becomes a non-negative safe
integer or `null`. Missing or malformed names, dates, and episode counts never
remove an otherwise valid season. `[impl+tests]`
