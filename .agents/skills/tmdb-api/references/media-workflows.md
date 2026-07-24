# TMDB media workflows

- `/search general` bypasses TMDB and enters the established Prowlarr flow.
- `/search movie` calls movie search only.
- `/search tv` calls TV search only.

All are guild-authorized, DM-denied, mention-safe, and ephemerally deferred.
`[impl+tests]`

Movie/TV search displays up to 10 results in upstream order plus one final
`Search exactly as entered` option. Labels use canonical title/name;
descriptions use `<year> • Movie|TV` or `Year unknown • Movie|TV`.
`[impl+tests]`

The custom ID is HMAC-signed, expires after 15 minutes, and binds requester,
media type, and a digest of the original query. Numeric IDs plus per-option
HMACs are hidden option values; titles, years, and the query are not stored in
the custom ID. `[impl+tests]`

The exact query remains in the user-visible heading with reversible Markdown
and control-character escaping. It is recovered from the component
interaction's attached bot-authored message and accepted only when its digest
matches the signed payload. Discord signs the whole interaction request; the
repository additionally validates field limits, option HMAC, and digest.
`[impl+tests]`

A media choice re-fetches `/movie/{id}` or `/tv/{id}` according to the signed
media type. Prowlarr receives `canonical title + space + year` when a valid
year exists, otherwise canonical title only. The exact-search choice makes no
details request and sends the reconstructed original query directly to
Prowlarr. Both paths reuse the same selectable/caching/release-menu workflow.
`[impl+tests]`
