---
type: Repository Guide
title: TorrentBot maintainer quickstart
description: Entry point for maintaining the TypeScript Cloudflare Worker, with system map, task routing, focused tests, and operational boundaries.
tags: [repository, quickstart, cloudflare, discord]
openwiki:
  roles: [repository, architecture, testing]
  source_paths: [src/index.ts, package.json, wrangler.jsonc]
  validation_commands: [npm run typecheck]
---

# TorrentBot maintainer quickstart

TorrentBot is a stateless TypeScript Cloudflare Worker that serves two deliberately separate HTTP surfaces:

1. a public, Ed25519-verified Discord interaction webhook that offers guild-authorized torrent search, media selection, TorBox submission, and status; and
2. a bearer-authenticated internal automation API for Prowlarr search and TorBox operations.

Start with [Worker architecture](architecture-overview.md) for route ownership and runtime boundaries. Read [security and reliability](security-and-reliability.md) before changing authentication, configuration, error paths, or output containing untrusted/upstream data.

## Knowledge base map

- [Worker architecture](architecture-overview.md) — Cloudflare entrypoint, route map, configuration boundary, and route-specific ownership.
- [Discord interactions](discord-interactions.md) — webhook verification, callbacks, follow-ups, component signing, and command dispatch.
- [Internal API](internal-api.md) — bearer-authenticated automation endpoints and JSON contract.
- [Search and media](search-and-media.md) — general/movie/TV paths, TMDB selection, TV seasons, release menus, and cache badges.
- [Torrent management](torrent-management.md) — `/add`, release submission, duplicate recovery, bounded polling, temporary links, and `/status`.
- [Upstream integrations](upstream-integrations.md) — Prowlarr, TMDB, TorBox, Discord REST, timeout/error normalization.
- [Development and deployment](development-and-deployment.md) — local dev, deterministic tests, registration, generated types, and release tooling.

## Task routing

| Change area or user intent | Relevant wiki page | Exact source entry points | Important symbols or types | Focused tests | Minimal validation command |
| --- | --- | --- | --- | --- | --- |
| Route or health behavior | [Worker architecture](architecture-overview.md#change-navigation) | `src/index.ts`, `src/routes/discord.ts`, `src/routes/api.ts` | `handler`, `handleDiscordInteractions`, `handleApiRequest` | `test/index.spec.ts` | `npm test -- --run test/index.spec.ts` |
| Discord verification or response lifecycle | [Discord interactions](discord-interactions.md#change-navigation-and-test-matrix) | `src/routes/discord.ts`, `src/discord/{verify,interactions,responses,client}.ts` | `verifyDiscordRequest`, `routeInteraction`, callback builders | `test/discord.spec.ts`, `test/discord-client.spec.ts` | `npm test -- --run test/discord.spec.ts test/discord-client.spec.ts` |
| Component tamper/expiry/requester behavior | [Discord interactions](discord-interactions.md#component-safety-contract) | `src/utils/signing.ts`, `src/commands/component.ts` | `parseAndVerifyCustomId`, `WorkflowComponentPayload` | `test/signing.spec.ts`, `test/component.spec.ts` | `npm test -- --run test/signing.spec.ts test/component.spec.ts` |
| General/movie/TV search or season UX | [Search and media](search-and-media.md#change-recipes-and-focused-validation) | `src/commands/{search,media,season,component}.ts` | `handleSearchCommand`, `buildTvSeasonQuery`, `completeSearch` | `test/media-search.spec.ts`, `test/tv-season-flow.spec.ts`, `test/season.spec.ts` | `npm test -- --run test/media-search.spec.ts test/tv-season-flow.spec.ts test/season.spec.ts` |
| Prowlarr/TMDB adapter behavior | [Upstream integrations](upstream-integrations.md#change-navigation) | `src/services/{prowlarr,tmdb}.ts` | `searchProwlarr`, `searchTmdb`, `getTmdbDetails` | `test/prowlarr.spec.ts`, `test/tmdb.spec.ts` | `npm test -- --run test/prowlarr.spec.ts test/tmdb.spec.ts` |
| TorBox add/poll/link/status behavior | [Torrent management](torrent-management.md#change-navigation-and-behavioral-matrix) | `src/services/torbox.ts`, `src/commands/{add,status,component}.ts` | `waitForTorrentReady`, `selectDownloadTarget`, `progressPercent` | `test/torbox.spec.ts`, `test/commands.spec.ts`, `test/component.spec.ts` | `npm test -- --run test/torbox.spec.ts test/commands.spec.ts test/component.spec.ts` |
| Internal automation endpoint | [Internal API](internal-api.md#change-navigation) | `src/routes/api.ts`, `src/utils/auth.ts` | `handleApiRequest`, `isValidBearer` | `test/api.spec.ts` | `npm test -- --run test/api.spec.ts` |
| Binding, auth, timeout, error policy | [Security and reliability](security-and-reliability.md#change-navigation) | `src/config.ts`, `src/utils/{auth,http,errors}.ts`, `wrangler.jsonc` | `getConfig`, `authorizeGuild`, `fetchText` | `test/config.spec.ts` | `npm test -- --run test/config.spec.ts` |
| Command registration or deployment | [Development and deployment](development-and-deployment.md#change-navigation) | `scripts/*`, `package.json`, `wrangler.jsonc` | `commands` | `test/command-registration.spec.ts` | `npm test -- --run test/command-registration.spec.ts` |

## Default maintenance sequence

1. Choose the narrow row above and read the linked canonical page.
2. Start from its symbols and focused tests; do not search the entire repository first.
3. Preserve trust boundaries: Discord verification before parse, bearer auth before internal API dispatch, guild authorization before Discord TorBox actions, and HMAC/requester/expiry checks before component mutations.
4. Run the focused command. Add `npm run typecheck` for type or binding changes. Reserve `npm test -- --run` for release or cross-cutting work; run `npm run cf-typegen` only after Wrangler binding changes.
5. For a schema change, registration/deploy is a separate operational action, not a replacement for focused tests.

## Backlog

No evidence-blocked documentation areas remain from the current inspected Worker source and tests. Git-history comparison could not be performed because `.openwikiignore` restricts shell history access; this wiki was built from current allowed evidence after the prior interrupted initialization.