---
type: Integration Reference
title: Upstream service adapters and safe data boundaries
description: Prowlarr, TMDB, TorBox, and Discord follow-up integration contracts, normalization behavior, transport timeouts, and credential-safe errors.
tags: [integrations, prowlarr, tmdb, torbox, discord, reliability]
openwiki:
  roles: [integration, security, operations]
  change_kinds: [upstream-api, normalization, timeout]
  source_paths: [src/services/prowlarr.ts, src/services/tmdb.ts, src/services/torbox.ts, src/discord/client.ts, src/utils/http.ts, src/utils/errors.ts]
  symbols: [searchProwlarr, searchTmdb, getTmdbDetails, createTorrent, requestDownloadLink, fetchText]
  test_paths: [test/prowlarr.spec.ts, test/tmdb.spec.ts, test/torbox.spec.ts, test/discord-client.spec.ts]
  invariants: [Raw upstream payloads, request URLs, tokens, and credential-bearing proxy links do not cross normalized error or presentation boundaries.]
  validation_commands: [npm test -- --run test/prowlarr.spec.ts test/tmdb.spec.ts test/torbox.spec.ts test/discord-client.spec.ts]
---

# Upstream service adapters and safe data boundaries

The Discord workflows documented in [search and media](search-and-media.md) and [torrent management](torrent-management.md) depend on typed adapters rather than passing raw upstream responses into presentation. The [internal API](internal-api.md) calls the same Prowlarr and TorBox adapters but applies a different serialization policy.

## Shared transport and errors

`fetchText` wraps `fetch` with `AbortSignal.timeout`; the configured default is 10 seconds. It converts aborts into `UpstreamTimeoutError` and other fetch/read failures into `UpstreamNetworkError`, so raw fetch errors cannot leak URLs. Adapters parse and normalize body structure into `UpstreamStatusError`, `UpstreamParseError`, or for TorBox envelopes `UpstreamApiError`. These types carry service classification and safe details, not request URLs, response payloads, magnets, or credentials.

| Adapter | Auth and endpoints | Normalization and safety contract |
| --- | --- | --- |
| Prowlarr `searchProwlarr` | `GET /api/v1/search`; `X-Api-Key` header | Requests and returns a bounded 1–100 result set, then sorts by seeders descending, size descending, title ascending. It never propagates Prowlarr proxy `downloadUrl`; it accepts only raw `magnet:` values or synthesizes a bare BTIH magnet from `infoHash`. `infoUrl` is the safe result link. |
| TMDB `searchTmdb`, `getTmdbDetails` | HTTPS TMDB v3 search/details; Bearer read token | Searches movie or TV with adult content disabled, retains at most ten valid de-duplicated matches, and normalizes bounded text, dates, posters, genres, and seasons. Details must match the requested numeric ID. |
| TorBox | Main API; Bearer API key | Creates torrents, lists/fetches fresh torrents, checks cache in batch, and requests download links. Parsed envelope failures become safe structured errors. Cache checks are advisory. |
| Discord client | Interaction webhook endpoints authenticated by interaction token | Edits original/follow-up messages and creates ephemeral follow-ups. It always sends `allowed_mentions: { parse: [] }` and turns Discord error bodies into bounded safe diagnostics. |

## Cross-integration invariants

Prowlarr is the release search authority. TMDB only supports movie/TV disambiguation and trusted canonical metadata; general Discord search never sends a request to TMDB. TorBox cache checks enrich menu display but neither submit a torrent nor make cache availability a requirement for Prowlarr search.

TorBox download-link requests are special: the upstream contract requires an API token query parameter, so the adapter ensures that URL stays internal and does not preserve it in errors. It rejects a returned link unless it parses as `https:`. Discord's interaction token likewise appears only in internal webhook URL construction.

## Change navigation

| Change | Start at | Focused validation | Escalate when |
| --- | --- | --- | --- |
| Prowlarr query/result model | `src/services/prowlarr.ts`, `src/types/search.ts` | `npm test -- --run test/prowlarr.spec.ts` | Result display/selectability changes: also run `test/selectable.spec.ts` and `test/commands.spec.ts`. |
| TMDB fields or media details | `src/services/tmdb.ts`, `src/types/media.ts` | `npm test -- --run test/tmdb.spec.ts` | Media/season interaction behavior changes: also run `test/media-search.spec.ts test/tv-season-flow.spec.ts`. |
| TorBox endpoint/poll/link target | `src/services/torbox.ts`, `src/types/torbox.ts` | `npm test -- --run test/torbox.spec.ts` | Discord selected-release/status changes: add `test/component.spec.ts test/commands.spec.ts`. |
| Follow-up API payload/errors | `src/discord/client.ts`, `src/discord/presentation.ts` | `npm test -- --run test/discord-client.spec.ts test/presentation.spec.ts` | Callback timing changes: add `test/discord.spec.ts`. |

Do not copy a raw upstream field into a user-facing or API serializer just because it exists. First decide whether it can contain a proxy URL, credential, server path, unbounded text, or untrusted identifier; the adapter boundary is where that decision belongs.