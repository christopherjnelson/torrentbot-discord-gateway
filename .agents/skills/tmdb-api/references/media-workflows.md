# TMDB media workflows

- `/search general` bypasses TMDB and enters the established Prowlarr flow.
- `/search movie` calls movie search only.
- `/search tv` calls TV search only.

All are guild-authorized, DM-denied, mention-safe, and ephemerally deferred.
`[impl+tests]`

Movie/TV search displays up to 10 results in upstream order. Only media
matches occupy the dropdown. `Search Exactly as Entered` and `Cancel` are
buttons. Labels use canonical title/name; descriptions use
`<year> • Movie|TV` or `Year unknown • Movie|TV`.
`[impl+tests]`

The custom ID is HMAC-signed, expires after 15 minutes, and binds requester,
media type, and a digest of the original query. Numeric IDs plus per-option
HMACs are hidden option values; titles, years, and the query are not stored in
the custom ID. `[impl+tests]`

The exact query remains in the bot-authored embed footer with reversible
Markdown and control-character escaping. It is recovered from the component
interaction's attached bot-authored message and accepted only when its digest
matches the signed payload. Discord signs the whole interaction request; the
repository additionally validates field limits, option HMAC, and digest.
`[impl+tests]`

A movie choice re-fetches `/movie/{id}` and first renders a details card.
Only after `Search Releases` is chosen, Prowlarr receives
`canonical title + space + year` when a valid year exists, otherwise canonical
title only. `[impl+tests]`

A TV choice re-fetches `/tv/{id}`, normalizes its embedded season summaries,
and renders a details card with a season-only select menu. Every page contains
up to 20 seasons. Complete Series, optional Specials, Search Exactly as
Entered, signed Previous/Next navigation, Back, and Cancel are buttons.
Specials is displayed as `Specials`, never `Season 0`. Every normalized season
is reachable and no page exceeds Discord's 25-option limit. `[impl+tests]`

TV Complete produces `<canonical title> complete`; a season produces
`<canonical title> S<at-least-two-digits>` (`0` → `S00`, `3` → `S03`,
`100` → `S100`). A Complete/season choice re-fetches trusted TV details again,
and a selected season must still exist before Prowlarr is called. No year,
TMDB ID, episode count, or media label is appended. `[impl+tests]`

The exact-search choice in either media menu makes no additional details
request and sends the reconstructed original query directly to Prowlarr. All
paths reuse the same selectable/caching/release-menu workflow. `[impl+tests]`

Season custom IDs carry only action, requester, expiry, series ID, zero-based
page, and the signed original-query digest. Season option values have a
context-bound HMAC; action/page buttons use signed workflow custom IDs.
Titles, original queries, and season lists are not embedded. Navigation
preserves the original component expiry rather than extending it.
`[impl+tests]`
## Guided card continuation `[impl+tests]`

Selecting a TMDB match re-fetches trusted details and edits the same ephemeral
response into a traditional Discord embed. Movie cards expose Search Releases,
Search Exactly as Entered, Back, and Cancel buttons. TV cards expose Complete
Series, optional Specials, Search Exactly as Entered, Back, Cancel, and a
season-only select menu with signed Previous/Next buttons. Async component
transitions use deferred update callback type 6 so the current controls remain
until the replacement is ready.

Back to results re-runs the original TMDB search; Back from releases re-fetches
trusted details by signed TMDB ID. Query text is recovered from a bot-authored
embed footer and checked against the signed digest. Custom IDs never contain
the title, overview, poster path, or full query.
