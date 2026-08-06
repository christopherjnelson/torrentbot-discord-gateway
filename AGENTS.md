# TorrentBot contributor guide

## Purpose and architecture

TorrentBot is a TypeScript Cloudflare Worker with two interfaces:

- `POST /discord/interactions` verifies and routes Discord slash commands and
  message components. Longer work is acknowledged immediately and continued
  with `ctx.waitUntil()` plus Discord webhook edits.
- `/api/*` is a separate bearer-authenticated JSON API for trusted automation.

TMDB resolves authoritative movie and TV metadata, Prowlarr supplies normalized
release results, and TorBox accepts magnets, reports readiness, and creates
temporary download links. The Worker is stateless: configuration comes from
Wrangler variables/secrets and no durable storage is used. See
[the architecture guide](docs/architecture.md) and [the user README](README.md).

For Cloudflare runtime or Wrangler changes, retrieve current Cloudflare docs
before relying on remembered APIs or limits. Run `npm run cf-typegen` after
changing bindings in `wrangler.jsonc`.

## Security invariants

- Verify Discord's Ed25519 signature against the untouched request body before
  JSON parsing, routing, or side effects. Keep the signed timestamp in that
  verification input. Do not weaken replay handling; if freshness semantics
  change, add explicit timestamp-age tests rather than assuming signatures alone
  reject an old, correctly signed request.
- Preserve fail-closed guild authorization and requester binding for commands and
  components. Direct messages and malformed guild configuration must not gain
  TorBox access.
- Treat custom IDs, select values, embed-derived state, and all Discord payloads
  as untrusted. Keep component state signed, length-bounded, requester-bound,
  tamper-resistant, and expiring.
- Resolve selected media IDs back through TMDB; never trust client-supplied
  titles, years, seasons, hashes, or other metadata when authoritative data is
  available.
- Keep bearer authentication on every `/api/*` route and preserve safe response
  envelopes and serialization boundaries.
- Never log or commit secrets, tokens, magnet URIs, webhook URLs, temporary
  download URLs, production payloads, or complete credential-bearing request
  URLs.
- Preserve upstream timeouts, bounded TorBox polling, immediate Discord
  acknowledgements, ephemeral responses, and safe error normalization.

## Task routing

| Change | Source and important symbols | Focused tests | Verify |
| --- | --- | --- | --- |
| Discord commands or interaction routing | `src/routes/discord.ts`, `src/discord/interactions.ts`, `src/commands/search.ts`, `src/commands/add.ts`, `src/commands/status.ts`, `src/commands/component.ts`; `handleDiscordInteractions`, `routeInteraction` | `test/index.spec.ts`, `test/discord.spec.ts`, `test/commands.spec.ts`, `test/component.spec.ts` | `npm test -- --run test/index.spec.ts test/discord.spec.ts test/commands.spec.ts test/component.spec.ts` |
| Movie/TV search and navigation | `src/commands/search.ts`, `src/commands/media.ts`, `src/commands/season.ts`, `src/commands/component.ts`, `src/discord/presentation.ts`; `completeMediaLookup`, `buildMediaComponents`, `buildSeasonComponents` | `test/media-search.spec.ts`, `test/tv-season-flow.spec.ts`, `test/season.spec.ts`, `test/presentation.spec.ts` | `npm test -- --run test/media-search.spec.ts test/tv-season-flow.spec.ts test/season.spec.ts test/presentation.spec.ts` |
| Signed component state | `src/utils/signing.ts`, `src/utils/selectable.ts`; custom-ID builders/parsers and signed option extraction | `test/signing.spec.ts`, `test/selectable.spec.ts`, `test/component.spec.ts` | `npm test -- --run test/signing.spec.ts test/selectable.spec.ts test/component.spec.ts` |
| TMDB resolution | `src/services/tmdb.ts`, `src/types/media.ts`; `searchTmdb`, `getTmdbDetails`, normalization helpers | `test/tmdb.spec.ts`, `test/media-search.spec.ts`, `test/tv-season-flow.spec.ts` | `npm test -- --run test/tmdb.spec.ts test/media-search.spec.ts test/tv-season-flow.spec.ts` |
| Prowlarr queries/results | `src/services/prowlarr.ts`, `src/types/search.ts`; `searchProwlarr`, `sortResults`, release normalization | `test/prowlarr.spec.ts`, `test/discord.spec.ts`, `test/api.spec.ts` | `npm test -- --run test/prowlarr.spec.ts test/discord.spec.ts test/api.spec.ts` |
| TorBox submission/readiness/files | `src/services/torbox.ts`, `src/commands/component.ts`, `src/commands/add.ts`, `src/commands/status.ts`; `createTorrent`, `findTorrentByHash`, `waitForTorrentReady`, `selectDownloadTarget` | `test/torbox.spec.ts`, `test/component.spec.ts`, `test/commands.spec.ts` | `npm test -- --run test/torbox.spec.ts test/component.spec.ts test/commands.spec.ts` |
| Internal API | `src/routes/api.ts`, `src/utils/auth.ts`; `handleApiRequest` and route handlers | `test/api.spec.ts` | `npm test -- --run test/api.spec.ts` |
| Configuration/environment | `src/config.ts`, `wrangler.jsonc`, `.dev.vars.example`; `getConfig`, `authorizeGuild` | `test/config.spec.ts` | `npm test -- --run test/config.spec.ts` |
| Worker routes, bindings, or deployment | `src/index.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `scripts/register-commands.mjs` | `test/index.spec.ts`, `test/command-registration.spec.ts`, `test/config.spec.ts` | `npm test -- --run test/index.spec.ts test/command-registration.spec.ts test/config.spec.ts && npm run typecheck` |

## Change workflow

1. Inspect the implementation and nearby tests before editing.
2. Add focused regression coverage and run the smallest relevant command above.
3. Run the full supported suite: `npm test -- --run` and `npm run typecheck`.
4. Preserve HTTP response shapes and Discord command/component compatibility
   unless the task explicitly changes them.
5. Update `README.md` only when user-visible behavior or setup changes; update
   `docs/architecture.md` when cross-cutting boundaries or flows change.

## Operational restrictions

- Do not deploy, publish, push, rotate credentials, or modify production or
  external services unless explicitly requested.
- Preserve unrelated work in a dirty worktree; never discard changes to make a
  task easier.
- Avoid commands that print secrets. Redact sensitive output before sharing it.
