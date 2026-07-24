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
impossible dates yield `year: null`. Details normalize through the same type
and must return the exact requested ID. `[impl+tests]`
