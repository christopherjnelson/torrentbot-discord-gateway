# TorrentBot — Discord gateway on Cloudflare Workers

TorrentBot is a Discord bot built as a TypeScript Cloudflare Worker. It lets a
Discord guild search for torrents through a self-hosted
[Prowlarr](https://prowlarr.com) instance and optionally submit magnets to a
TorBox account — no servers, no n8n workflow required for the core flow.

```
Discord (slash commands)
   │  POST /discord/interactions (Ed25519 signed)
   ▼
Cloudflare Worker ─────────────────────────────┐
   │                                           │
   ├─► TMDB API (movie/TV disambiguation)      │
   │    GET api.themoviedb.org/3/…             │
   │                                           │
   ├─► Prowlarr API (search)                   │
   │    GET prowlarr.example.com/api/v1/search │
   │                                           │
   ├─► TorBox API (add/status)                 │
   │    POST api.torbox.app/v1/api/torrents/…  │
   │                                           │
   └─► Discord follow-up webhooks              │
         PATCH …/webhooks/{app}/{token}/…       │
                                                │
n8n / automation ──► /api/* (Bearer auth) ──────┘
```

General search goes directly to Prowlarr. Movie search uses TMDB to choose a
canonical title/year. TV search uses TMDB to choose a series and then Complete
series, Specials, or a numbered season before searching Prowlarr.
Torrent management goes directly to TorBox. The TorBox Voyager/Torznab
endpoint (`search-api.torbox.app`) is **not** used and no Voyager API key is
required.

## Quick Start

Get TorrentBot up and running in 6 steps:

1. **Install dependencies**: Clone the repository and run `npm install`.
2. **Configure local environment**: Copy `.dev.vars.example` to `.dev.vars` and fill in your development keys and IDs.
3. **Set Cloudflare secrets**: Configure production secrets using `npx wrangler secret put <NAME>` for keys like `DISCORD_PUBLIC_KEY`, `PROWLARR_API_KEY`, and others.
4. **Deploy the Worker**: Run `npm run deploy` to publish the gateway to Cloudflare Workers.
5. **Register commands**: Run `npm run discord:register` to publish the slash commands to your Discord guild.
6. **Test in Discord**: Configure the Interactions Endpoint URL in your Discord Developer Portal, then run a search (e.g. `/search general query:ubuntu`) to verify.

## Implemented commands and routes

**Discord (guild-scoped slash commands)**

| Command | Description | Who can use it |
| --- | --- | --- |
| `/search general query:<text>` | Search all configured Prowlarr indexers directly; TMDB is never called | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/search movie query:<title>` | Search TMDB movies, choose a canonical title/year or `Search exactly as entered`, then search releases through Prowlarr | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/search tv query:<title>` | Search TMDB TV series, choose Complete series, Specials, a numbered season, or `Search exactly as entered`, then search releases through Prowlarr | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/add magnet:<uri>` | Submit a magnet URI to TorBox | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/status` | List the TorBox account's downloads (ephemeral); ready torrents include temporary download links | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |

**HTTP routes**

| Route | Description |
| --- | --- |
| `GET /` | Health check |
| `POST /discord/interactions` | Discord interaction webhook (Ed25519 verified) |
| `POST /api/search` | Internal search API (`{query, limit?}`), backed by Prowlarr |
| `POST /api/torrents` | Internal add-magnet API (`{magnet}`), backed by TorBox |
| `GET /api/torrents/:id` | Internal torrent status API, backed by TorBox |

All `/search` forms answer Discord within the 3-second deadline using an
ephemeral deferred response (type 5 with flag 64), run bounded upstream work
via `ctx.waitUntil`, and edit the original response through the follow-up webhook
(`PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`).
`/add` and `/status` defer ephemerally and complete the same way.

`/search general` bypasses TMDB entirely. `/search movie` calls
`GET /3/search/movie`; `/search tv` calls `GET /3/search/tv`. Initial media
choices are shown in deterministic upstream order (up to 10), using canonical
title/name and year. Selecting a media item re-fetches the corresponding
`GET /3/movie/{id}` or `GET /3/tv/{id}` details record so client-provided
title/year data is never trusted.

The media workflow is one evolving ephemeral Discord message. Traditional
embeds show trusted TMDB metadata and a poster thumbnail when TMDB returns a
valid poster path. Dropdowns are reserved for TMDB matches, seasons, and
Prowlarr releases; obvious actions and navigation use signed buttons.

Movie:

```text
search → choose movie → view media card → search releases
       → choose release → processing → download
```

The movie card includes title, year, runtime, bounded genres, a concise
overview, and optional poster. **Search Releases** sends
`<canonical title> <year>` when a valid year exists, otherwise the canonical
title. **Search Exactly as Entered**, **Back**, and **Cancel** are buttons.

TV:

```text
search → choose series → view series card → choose complete/specials/season
       → choose release → processing → download
```

TV details include trusted TMDB season summaries. The card presents
**Complete Series**, **Specials** when season 0 exists, every returned season,
**Search Exactly as Entered**, **Back**, and **Cancel**. The resulting
Prowlarr queries remain predictable:

```text
Breaking Bad complete
Breaking Bad S03
Doctor Who S00
```

Specials maps to `S00`; positive season numbers use at least two digits and
are not truncated above 99. No year, TMDB ID, episode count, or media label is
appended. Long-running series use a season dropdown plus signed
**Previous**/**Next** buttons on pages of 20, so no returned season is silently
omitted. Episode selection is not currently supported.

Every media and TV screen retains **Search Exactly as Entered**. It bypasses
canonicalization and sends the original validated query directly to Prowlarr.
The exact query is recovered from a bot-authored embed footer with reversible
escaping and accepted only when it matches the signed query digest. Compact
custom IDs contain workflow action, requester, expiry, media type, TMDB ID,
season/page state, and query digest—never titles, overviews, or full queries.
Release option values also carry an HMAC so a hidden hash cannot be replaced.

General and movie searches do not use the season-selection step.

When Prowlarr returns results with valid info hashes, `/search` includes a
Discord select menu component (placeholder: "Select a release to download").
The original requester can use this menu to submit a selected result to
TorBox without manually copying the magnet URI. Up to 10 distinct valid
releases are shown; the bot requests more from Prowlarr (25) to provide
headroom for duplicate hashes, invalid hashes, and empty labels.

During `/search`, the selectable results' info hashes are also checked
against TorBox's `POST /torrents/checkcached` endpoint in a single batch
request. Results TorBox already holds are marked with a `⚡ Cached` badge in
the option description; uncached or unknown results are not labeled. The
check is **advisory only**: it does not add anything to the TorBox account,
and if TorBox is not configured or the cache check fails for any reason,
`/search` still returns the normal Prowlarr results without badges.

When an authorized member selects a release, the bot:

1. **Validates** the signed component payload, the requester binding (only
   the user who ran `/search` may use its menu), and the authorized-guild
   check. Failures answer ephemerally and leave the search menu untouched.
2. **Replaces** the same ephemeral response with a processing card and removes
   stale controls. Async media/season transitions use Discord callback type 6,
   preserving the current card until its replacement is ready.
3. **Submits** the magnet to TorBox. If TorBox reports the item already
   exists (`DUPLICATE_ITEM`), the bot locates the existing torrent by its
   info hash (the stable documented identifier, never by title) and
   continues.
4. **Polls** TorBox for readiness in a short bounded window (see
   *TorBox polling* below).
5. **Edits** that same ephemeral response with a processing or ready card.
   Ready cards use a Discord HTTPS link button plus **New Search**.

Back navigation re-runs a trusted TMDB search or details lookup using signed
IDs. Cancel replaces the message with `Search cancelled.` and removes every
control. All component interactions are HMAC-signed, requester-bound,
guild-authorized, stateless, and expire after 15 minutes.

`/search general` never calls TMDB. It moves directly from a concise search
state to the release card, then uses the same processing/download presentation.

## Detailed Workflows

### TorBox download flow

A selection produces one of these ephemeral responses:

**Cached or quickly ready**

```
Added to TorBox.

**Example Release (2026) [1080p]**
Ready to download:
Download button
```

When a movie or episode release contains one primary video plus recognizable
extras such as samples, subtitles, NFO/checksum files, or artwork, the bot
returns the primary video directly. Ambiguous multi-file content—including
season packs, archive parts, installers, and unknown companion files—uses
TorBox's whole-torrent zip archive link:

```
Added to TorBox.

**Some.Season.Pack.2026**
Ready to download (12 files):
Download button (ZIP)
```

**Still processing** (torrent added but not ready within the bounded window)

```
Added to TorBox.

**Example Release (2026) [1080p]**
TorBox is still processing this torrent (ID `42`). Use `/status` to check it later.
```

**Failure** (added but a link could not be generated yet)

```
The torrent was added, but TorrentBot could not generate a download link yet.
Use `/status` to check it later.
```

All of these responses are **ephemeral**. A single file or unambiguous primary
media file uses its direct temporary URL; ambiguous or multipart content uses
TorBox's ZIP URL. The HTTPS URL is placed only on the final Discord link
button, is never persisted or logged, and is temporary (about three hours for
starting a download).

### TorBox polling

After submitting a torrent the bot polls TorBox's `GET /torrents/mylist?id=…`
endpoint with `bypass_cache=true` (the official docs note the list is otherwise
cached for 600 seconds). Polling is strictly bounded:

- the first poll runs immediately after a successful submission;
- subsequent polls run every `TORBOX_POLL_INTERVAL_MS` (default `2500` ms);
- at most `TORBOX_POLL_MAX_ATTEMPTS` polls are performed (default `7`),
  giving a window of roughly 15–20 seconds;
- polling stops as soon as the torrent is ready, the budget is exhausted, the
  torrent disappears after being seen, or an upstream error occurs.

Readiness is determined by TorBox's `download_finished` field. The official
docs explicitly state that `download_state: "completed"` must *not* be used for
download-completion status, so the bot does not rely on it.

This is a **best-effort, bounded** check only. The bot does not persist any
state and does **not** notify the user later if the torrent finishes after the
window. Use `/status` as the fallback for items still processing. Persistent
background monitoring (KV, D1, Durable Objects, Queues, Workflows, or cron) is
deliberately out of scope for this task.

### `/status` download links

`/status` lists the TorBox account's downloads ephemerally (up to 10 entries).
Ready torrents (`download_finished === true`) include a temporary TorBox
download link using the same rules as the selection workflow: exactly one file
or one primary media file with only recognizable extras → a direct file link;
ambiguous or multipart content → a whole-torrent ZIP link.
Processing torrents show status/progress only — no link is requested or
displayed. Link generation is best-effort enrichment: if a link request fails
for one torrent, that torrent is still shown without a link and the rest of
the list is unaffected. Generated links are temporary CDN URLs (~3 hours),
shown only in the ephemeral response, never logged, and never persisted.

## Setup & Configuration

### Prerequisites

- Node.js 22+ and npm
- A Cloudflare account with Workers enabled
- A Discord account and a Discord application (below)
- A running Prowlarr instance reachable from Cloudflare (this deployment uses
  `https://prowlarr.example.com`) with its API key
- A TMDB API read access token (only needed for `/search movie` and
  `/search tv`)
- A TorBox account with an API key (only needed for `/add` and `/status`)

### Discord application setup

1. Create an application at <https://discord.com/developers/applications>.
2. Note the **Application ID** and **Public Key** (General Information).
3. Create a bot user (Bot section) and copy the **Bot Token**.
4. Enable the bot in your guild with the `applications.commands` scope
   (OAuth2 → URL Generator → `bot` + `applications.commands`; no special bot
   permissions are needed for slash commands).
5. Note your guild (server) ID: Discord client → right-click server →
   "Copy Server ID" (requires Developer Mode).

### Prowlarr setup

1. In Prowlarr, add and test your indexers (Settings → Indexers) and confirm
   a manual search in the Prowlarr UI returns results.
2. Copy the API key: **Settings → General → Security → API Key**.
3. Verify the instance independently (replace host and key):

```sh
curl -sS "https://prowlarr.example.com/api/v1/search?query=example&limit=2" \
  -H "X-Api-Key: $PROWLARR_API_KEY" | head -c 600
```

A valid key returns a JSON array of releases (`title`, `size`, `seeders`,
`leechers`, `indexer`, `infoHash`, …). A missing/invalid key returns `401`.
`https://prowlarr.example.com/ping` answers `{"status":"OK"}` without a key
and is a quick liveness check.

### Configuration Variables

#### Local Environment (`.dev.vars`)

Fill in `.dev.vars` (never commit it — it is git-ignored):

| Variable | Secret? | Used for |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | secret | Verifying Discord request signatures |
| `DISCORD_APPLICATION_ID` | id | Command registration script |
| `DISCORD_BOT_TOKEN` | secret | Command registration script only |
| `DISCORD_GUILD_ID` | id | Guild-scoped command registration |
| `PROWLARR_API_KEY` | secret | Prowlarr search (`X-Api-Key` header) |
| `TMDB_READ_ACCESS_TOKEN` | secret | TMDB movie/TV search and selected-record details, including TV season summaries (`Authorization: Bearer …`); general search does not use it |
| `TORBOX_API_KEY` | secret | TorBox API (`/add`, `/status`, `/api/torrents`) |
| `INTERNAL_API_TOKEN` | secret | Bearer token for `/api/*` (generate a long random string) |
| `COMPONENT_SIGNING_SECRET` | secret | HMAC-SHA-256 signing for Discord component interactions (generate with `openssl rand -hex 32`) |
| `PROWLARR_URL` | var | Prowlarr base URL (set in `wrangler.jsonc`; `.dev.vars` overrides locally) |
| `TORBOX_ALLOWED_GUILD_IDS` | secret | Comma-separated Discord guild (server) IDs whose members may run `/search`, `/add`, `/status`, and the search-result selection flow (each entry must be a snowflake-style decimal string; missing/empty/malformed denies all Discord TorBox access). Treated as a secret so real guild IDs stay out of tracked files |
| `UPSTREAM_TIMEOUT_MS` | var | Optional upstream timeout override (default `10000`) |
| `TORBOX_POLL_INTERVAL_MS` | var | Optional delay between TorBox readiness polls after a selection (default `2500`, range 250–10000) |
| `TORBOX_POLL_MAX_ATTEMPTS` | var | Optional cap on TorBox readiness polls after a selection (default `7`, range 1–20) |

#### Cloudflare Production Secrets

Secrets (values never appear in the repo or in logs):

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put PROWLARR_API_KEY
npx wrangler secret put TMDB_READ_ACCESS_TOKEN
npx wrangler secret put TORBOX_API_KEY
npx wrangler secret put INTERNAL_API_TOKEN
npx wrangler secret put COMPONENT_SIGNING_SECRET
npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS
```

Generate the `COMPONENT_SIGNING_SECRET` with:

```sh
openssl rand -hex 32
```

`TORBOX_ALLOWED_GUILD_IDS` is a comma-separated list of Discord guild (server)
IDs; every member of an approved guild can use `/search`, `/add`, `/status`,
and the search-result selection flow. Enter multiple IDs as a single
comma-separated value (e.g. `123456789012345678,987654321098765432`). Each
entry must be a snowflake-style decimal string; missing/empty/malformed
configuration denies all Discord TorBox access. Direct messages are not supported.

Non-secret vars live in `wrangler.jsonc` (`PROWLARR_URL`,
`UPSTREAM_TIMEOUT_MS`, `TORBOX_POLL_INTERVAL_MS`, `TORBOX_POLL_MAX_ATTEMPTS`)
and can be edited there or in the Cloudflare dashboard.

## Deployment Checklist

1. Create the Discord application/guild, Prowlarr instance, and TorBox account.
2. Add real IDs and API keys to `.dev.vars` for local development.
3. Add production secrets to Cloudflare (`wrangler secret put …`) and verify the `PROWLARR_URL` in `wrangler.jsonc`.
4. Run `npm run discord:register` to register slash commands in your Discord guild.
5. Deploy the worker with `npm run deploy`.
6. Enter the Interactions Endpoint URL in the Discord Developer Portal.
7. First real searches: run `/search general query:ubuntu`,
   `/search movie query:star wars`, and `/search tv query:breaking bad`.
   Confirm that movie/TV display a TMDB choice menu, TV adds a season choice,
   and all three reach the normal Prowlarr release menu.

## Security Model

TorrentBot is designed with a strict zero-trust security architecture:

- **Guild Authorization**: Access to commands (`/search`, `/add`, `/status`) and search result menus is restricted to Discord guilds explicitly listed in `TORBOX_ALLOWED_GUILD_IDS`. Direct messages and unauthorized guilds are rejected, and the bot fails closed.
- **Ephemeral Responses**: Sensitive actions, such as `/status` listings or generated TorBox download links, are delivered strictly as **ephemeral** Discord responses, meaning they are only visible to the initiating user.
- **API-Key Secrecy**: 
  - **Prowlarr API**: Authenticated via the `X-Api-Key` header, never exposed in URLs or logs.
  - **TMDB API**: Authenticated with `TMDB_READ_ACCESS_TOKEN` in the
    `Authorization: Bearer` header. The token is never placed in a query
    parameter, component, error, or log.
  - **TorBox API**: Authenticated via a bearer token. The documented permalink structure that embeds API keys in download links is strictly avoided.
  - **Internal API**: Routes require authentication via `Authorization: Bearer <INTERNAL_API_TOKEN>`, verified using constant-time comparison (SHA-256 pre-hashed).
- **Proxy-URL Defense**: Prowlarr-returned proxy download/magnet URLs that embed API keys are never propagated, logged, or exposed. Instead, magnets are parsed and reconstructed cleanly from info hashes.
- **HTTPS-Only Downloads**: Only `https:` URLs returned by TorBox are accepted for temporary download and zip archive links.
- **No-Logging Rules**: Sensitive parameters (interaction tokens, API keys, full magnet URIs, temporary download URLs, raw search queries, selected TMDB titles, and upstream payloads) are never logged. Upstream errors are wrapped so they never leak endpoint URLs or credentials.
- **Signed Component Payloads**: Interactive select menus from `/search` are signed using HMAC-SHA-256 with `COMPONENT_SIGNING_SECRET`. The signature binds the payload to the original requester, preventing tampering and preventing other members in the guild from selecting someone else's search option. Component payloads expire after 15 minutes.
- **Safe Mentions**: All bot messages disable mention parsing (`allowed_mentions: { parse: [] }`) to prevent mention abuse or accidental notifications.

## Local Development & Testing

All development and verification scripts are managed via npm:

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the local Wrangler development server for real-time testing. |
| `npm test` | Runs the full Vitest test suite inside a simulated Cloudflare Workers environment. |
| `npm run typecheck` | Runs strict TypeScript compiler checks on both `src/` and `test/` codebases. |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` typescript bindings from `wrangler.jsonc`. |
| `npm run deploy` | Deploys the application directly to Cloudflare Workers. |
| `npm run deploy -- --dry-run` | Validates and builds the deployment bundle locally without uploading. |
| `npm run discord:register` | Registers the bot's slash commands to the designated Discord guild. |
| `npm run discord:unregister` | Unregisters/removes the guild slash commands. |

### Testing details

`npm test` runs Vitest inside a real Worker runtime (`@cloudflare/vitest-pool-workers`). Outbound HTTP requests are fully mocked via `fetchMock`, ensuring tests never call Discord, TMDB, Prowlarr, or TorBox APIs directly. Signed Discord request payloads are produced deterministically using a generated Ed25519 key pair, preserving complete signature verification in test assertions.

The test suite covers health checks, signature validation, typed command
routing, TMDB normalization/disambiguation, deferred responses, upstream
Prowlarr/TMDB/TorBox error and timeout scenarios, credential safety, and
internal API endpoints.

## For Developers

### Project layout

```
src/
  index.ts            route dispatch
  config.ts           env binding accessors (graceful degradation)
  discord/            types, Ed25519 verify, responses, follow-up client, router
  commands/           search, add, status, component (select menu handler), shared error mapping
  services/           prowlarr, TMDB, and torbox typed API boundaries
  routes/             discord webhook, internal API
  utils/              format, http (timeouts), errors, auth, magnet, signing (HMAC)
  types/              search, media, and torbox models
test/                 vitest + @cloudflare/vitest-pool-workers
scripts/              register-commands.mjs
```

### External API assumptions

Development assumes verified behaviors for Discord (Ed25519 interactions,
ephemeral deferring, component interactions), Prowlarr (search endpoint
parameter shapes and category mapping), TMDB (movie/TV search and details),
and TorBox (add, mylist caching, download links, and cache checks). For the
exact contracts, refer to the **Agent Skills** in `.agents/skills/`.

### Agent skills

Before modifying the integrations, consult the tracked agent skills:
- **TorBox API**: Read [`.agents/skills/torbox-api/SKILL.md`](.agents/skills/torbox-api/SKILL.md) for contracts, completion rules, cache-check details, and credentials safety.
- **Prowlarr API**: Read [`.agents/skills/prowlarr-api/SKILL.md`](.agents/skills/prowlarr-api/SKILL.md) for search normalization, proxy-URL security, and cache-enrichment details.
- **TMDB API**: Read [`.agents/skills/tmdb-api/SKILL.md`](.agents/skills/tmdb-api/SKILL.md) before changing movie/TV endpoints, normalization, component continuation, or token handling.

Always update these skills in the same change when verified API behaviors change.

## Internal API usage (n8n or other automation)

All routes require `Authorization: Bearer $INTERNAL_API_TOKEN`.

```sh
# Search (Prowlarr)
curl -X POST https://<worker>.workers.dev/api/search \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "example query", "limit": 5}'

# Add a magnet (201 on success, 409 on duplicate)
curl -X POST https://<worker>.workers.dev/api/torrents \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"magnet": "magnet:?xt=urn:btih:…"}'

# Status of one torrent
curl https://<worker>.workers.dev/api/torrents/42 \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN"
```

Search responses include `magnetUri` (the API is authenticated); torrent
responses never include download URLs, file lists, or server paths.

## Troubleshooting

- **"Missing Discord signature headers" / 401**: the request did not come
  from Discord or the `DISCORD_PUBLIC_KEY` is wrong.
- **Commands don't appear in Discord**: re-run `npm run discord:register`
  and check `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN`.
- **"Search is not configured"**: set `PROWLARR_URL` (var) and
  `PROWLARR_API_KEY` (secret).
- **"Movie and TV lookup is not configured"**: set
  `TMDB_READ_ACCESS_TOKEN` as a Worker secret and ensure
  `COMPONENT_SIGNING_SECRET` is configured. Local development may add
  `TMDB_READ_ACCESS_TOKEN=<local secret>` to the ignored `.dev.vars` file.
- **"The media lookup service is unavailable"**: TMDB timed out, rate
  limited the request, rejected the configured credential, or returned an
  unexpected response. The failure is isolated; retry later or use
  `/search general` to bypass TMDB.
- **"The upstream service rejected the configured credentials"**: the
  `PROWLARR_API_KEY` is wrong or was rotated; copy the current key from
  Prowlarr → Settings → General → Security → API Key.
- **`/add` says "TorrentBot is not enabled for this server"**: the
  interaction's guild is not listed in `TORBOX_ALLOWED_GUILD_IDS` (secret,
  comma-separated snowflake IDs). Add the guild ID with
  `npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS` and redeploy. Direct
  messages are not supported.
- **"TorrentBot authorization is not configured correctly"**:
  `TORBOX_ALLOWED_GUILD_IDS` is missing, empty, or contains a malformed
  (non-snowflake) entry; the bot fails closed. Set a valid comma-separated
  value with `npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS` and redeploy.

## Current limitations

- **Bounded readiness check only**: the selection flow polls TorBox for at
  most ~15–20 seconds. If a torrent is not ready within that window the bot
  tells the user it is still processing and stops — it does not persist any
  state and does **not** notify the user later when the torrent finishes.
  Use `/status` to check items still processing. Persistent background
  monitoring (KV, D1, Durable Objects, Queues, Workflows, cron, or external
  databases/n8n) is intentionally out of scope.
- **Ambiguous multi-file torrents**: season packs with multiple primary videos,
  multipart archives, installers, and releases with unknown companion files
  return a whole-torrent ZIP. Automatic direct-file selection is intentionally
  limited to one primary media file plus recognized samples, subtitles,
  metadata/checksum files, and artwork.
- **No TV episode selection**: TV search can choose Complete series, Specials,
  or a numbered season. It does not choose an individual episode.
- **Temporary links**: generated TorBox download URLs are temporary CDN links
  (~3 hours for starting a download), as documented. They are not persisted
  by the bot.
- The bot does not monitor download progress across requests.
