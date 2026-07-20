# torbox-api

A portable Agent Skill documenting the TorBox main-API behavior already
verified and implemented in this repository, so future agents can work with
the existing TorBox integration without re-researching or guessing the
endpoint contracts, readiness rules, duplicate behavior, cache checks, and
download-link workflow.

**Verification date:** 2026-07-20 (behavior established during the current
implementation work and recorded in `src/types/torbox.ts`,
`src/services/torbox.ts`, and the `README.md` "External API assumptions"
section).

---

## When to load this skill

Load this skill **before modifying anything that calls the TorBox main API**
(`https://api.torbox.app/v1/api`), including:

- `src/services/torbox.ts` (the typed TorBox client boundary),
- `src/types/torbox.ts` (envelope and torrent types),
- `src/commands/component.ts`, `src/commands/add.ts`, `src/commands/status.ts`,
  `src/routes/api.ts` (callers of the TorBox client),
- any TorBox-related test or fixture.

You do **not** need to load it for Prowlarr-only or Discord-only work.

## Reference files

| File | Contents |
| --- | --- |
| `references/endpoints.md` | Endpoint table: method, path, params, auth, verified status. |
| `references/response-shapes.md` | Envelope + per-endpoint `data` shapes (only the fields this repo models). |
| `references/torrent-workflows.md` | Verified end-to-end flows: create, duplicate recovery, lookup, polling, download link, cache check. |
| `references/security.md` | Where credentials travel and what must never be logged. |
| `references/known-quirks.md` | Documented quirks, limitations, and remaining uncertainties. |

Load the whole `references/` set when touching TorBox behavior; an endpoint
table alone is not enough to get readiness/duplicate/cache behavior right.

## Ground rules

1. **Do not invent TorBox fields or statuses.** Only the fields modelled in
   `src/types/torbox.ts` are used. If you believe a new field/status is needed,
   verify it against the official docs first (see "Rechecking official docs"
   below) and update this skill in the same change.
2. **The repository is the baseline.** `test/torbox.spec.ts` (55 tests) and
   `test/component.spec.ts` are the contract examples — they assert the exact
   request shapes, auth headers, envelope parsing, readiness rule, duplicate
   recovery, and download-link handling. Treat them as the source of truth for
   *verified* behavior. `test/fixtures.ts` and the synthetic JSON bodies in
   `test/torbox.spec.ts` are sanitized examples you may mirror.
3. **Distinguish verified from assumed.** Every factual API statement in the
   reference files is tagged:
   - `[impl+tests]` — verified by the current implementation and its passing tests.
   - `[docs 2026-07-20]` — verified against the official TorBox docs / OpenAPI
     spec on 2026-07-20 (see `src/types/torbox.ts` header and README).
   - `[uncertain]` — an explicitly documented limitation/uncertainty; do not
     rely on it as fact.
4. **Rechecking official docs.** Only consult the official TorBox
   documentation (`https://api-docs.torbox.app` Postman collection and the
   live OpenAPI spec at `https://api.torbox.app/openapi.json`) when:
   - the repository contains conflicting descriptions,
   - an endpoint contract is unclear,
   - the skill would otherwise record an assumption, or
   - a source URL or verification note must be confirmed.
   Do **not** re-browse the entire API merely to rewrite what is already
   verified here.
5. **Update this skill when verified API behavior changes.** If you change a
   TorBox endpoint call, add/remove a field, or confirm an `[uncertain]` item,
   update the relevant reference file and the verification date in the same
   commit. Keep `[impl+tests]` / `[docs 2026-07-20]` / `[uncertain]` tags
   accurate.

## Security rules (non-negotiable)

See `references/security.md` for the full list. In summary, never log, echo,
or embed in error messages:

- TorBox API keys or `Authorization` headers,
- the `requestdl` `token` query parameter (it carries the API key),
- full magnet URIs (accepted as input only),
- info hashes (except as non-sensitive identifiers in non-secret contexts),
- generated temporary download URLs,
- raw upstream request URLs or response bodies.

The TorBox client (`src/services/torbox.ts`) already enforces this: it throws
only the normalized `Upstream*` error types, which never carry URLs, hashes,
or credentials. Preserve that boundary.

## What this skill is not

- Not a re-statement of the full official TorBox API. Only the endpoints and
  fields this Worker uses are documented.
- Not a guide to the TorBox Voyager/Torznab search API (`search-api.torbox.app`),
  which this repo does **not** use.
- Not a guide to Prowlarr or Discord; see the README for those.
