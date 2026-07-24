# prowlarr-api

A portable Agent Skill documenting the Prowlarr search-API behavior already
verified and implemented in this repository, so future agents can work with
the existing `/search` integration without re-researching or guessing the
endpoint contract, authentication, result normalization, info-hash handling,
duplicate behavior, failure handling, and Discord-enrichment boundary.

**Verification date:** 2026-07-24 (workflow entry points reconfirmed).
Official-Prowlarr-docs verification tags in the reference files use
`[docs 2026-07-19]`, the date the repository records in
`src/services/prowlarr.ts` and the `README.md` "External API assumptions"
section. `[impl+tests]` marks behavior verified by the implementation and its
passing tests.

---

## When to load this skill

Load this skill **before modifying anything that searches or normalizes
Prowlarr results**, including:

- `src/services/prowlarr.ts` (the typed Prowlarr search adapter),
- `src/types/search.ts` (the normalized `TorrentResult` type),
- `src/commands/search.ts` (the Discord `/search general` command, canonical
  media-search continuation, and TorBox cache enrichment),
- `src/utils/selectable.ts` (selectable-result normalization for the menu),
- `src/routes/api.ts` (the internal `/api/search` route),
- any Prowlarr-related test or fixture (`test/prowlarr.spec.ts`,
  `test/selectable.spec.ts`, `test/fixtures.ts`).

You do **not** need to load it for TorBox-only or Discord-only work.

## Reference files

| File | Contents |
| --- | --- |
| `references/endpoints.md` | Endpoint table: method, path, params, auth, verified status. |
| `references/response-shapes.md` | Upstream `ReleaseResource` fields read vs. normalized `TorrentResult`; malformed-shape behavior. |
| `references/search-workflows.md` | Full `/search` flow: query → normalize → sort → cap → selectable → cache enrich → render; failure/fallback. |
| `references/security.md` | API-key handling, proxy-URL defense, what must never be logged or exposed. |
| `references/known-quirks.md` | Verified quirks, limitations, and remaining uncertainties. |

Load the whole `references/` set when touching Prowlarr behavior; an endpoint
table alone is not enough to get normalization, dedup, and cache-enrichment
behavior right.

## Ground rules

1. **Do not invent Prowlarr fields, categories, or endpoint behavior.** Only
   the fields modelled in `src/types/search.ts` and read in
   `src/services/prowlarr.ts` are used. If you believe a new field/endpoint is
   needed, verify it against official Prowlarr source/docs first (see
   "Rechecking official docs" below) and update this skill in the same change.
2. **The repository is the baseline.** `test/prowlarr.spec.ts` (16 tests) and
   `test/selectable.spec.ts` (13 tests) are the contract examples — they
   assert the exact request URL/headers, normalization, sorting, dedup, and
   proxy-URL defense. `test/fixtures.ts` (`PROWLARR_TWO_ITEM_JSON`,
   `PROWLARR_EMPTY_JSON`) are sanitized examples you may mirror.
3. **Distinguish verified from assumed.** Every factual API statement in the
   reference files is tagged:
   - `[impl+tests]` — verified by the current implementation and its passing tests.
   - `[docs 2026-07-19]` — verified against official Prowlarr source/docs on
     2026-07-19 (see `src/services/prowlarr.ts` header and README).
   - `[uncertain]` — an explicitly documented limitation/uncertainty; do not
     rely on it as fact.
4. **Rechecking official docs.** Only consult the official Prowlarr
   documentation/source (`SearchController.cs`, `SearchResource.cs`,
   `ReleaseResource.cs`, `AuthenticationBuilderExtensions.cs` on the Prowlarr
   develop branch) when:
   - the repository contains conflicting descriptions,
   - an endpoint contract is unclear,
   - authentication or parameter details are ambiguous,
   - the skill would otherwise state an assumption as fact, or
   - a source or verification note must be confirmed.
   Do **not** broadly re-research the entire Prowlarr API merely to rewrite
   what is already verified here.
5. **Update this skill when verified behavior changes.** If you change the
   Prowlarr endpoint call, add/remove a normalized field, or confirm an
   `[uncertain]` item, update the relevant reference file and the
   verification date in the same commit. Keep the evidence tags accurate.

## Security rules (non-negotiable)

See `references/security.md` for the full list. In summary, never log, echo,
or embed in Discord output:

- the Prowlarr API key or `X-Api-Key` header,
- credential-bearing proxy URLs (Prowlarr rewrites `downloadUrl`/`magnetUrl`
  into proxy URLs that embed the API key — see `references/security.md`),
- full magnet URIs in Discord output (synthesized magnets are submitted to
  TorBox only on selection),
- raw upstream request URLs or response bodies.

The Prowlarr adapter (`src/services/prowlarr.ts`) already enforces this: it
throws only the normalized `ConfigError` / `Upstream*` error types, which
never carry URLs, keys, or payloads. Preserve that boundary.

## What this skill is not

- Not a re-statement of the full official Prowlarr API. Only the search
  endpoint and the fields this Worker reads are documented.
- Not a guide to NZB/Usenet results. This app is BitTorrent/BTIH-only; see
  `references/known-quirks.md` for the unsupported-NZB note.
- Not a guide to TorBox or Discord; see the TorBox skill and the README.
