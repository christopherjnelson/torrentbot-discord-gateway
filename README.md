# TorrentBot — Discord gateway on Cloudflare Workers

TorrentBot is a Discord bot built as a TypeScript Cloudflare Worker. It lets a
Discord guild search for torrents through TorBox's Voyager search engine and
optionally submit magnets to a TorBox account — no servers, no n8n workflow
required for the core flow.

```
Discord (slash commands)
   │  POST /discord/interactions (Ed25519 signed)
   ▼
Cloudflare Worker ─────────────────────────────┐
   │                                           │
   ├─► Voyager Torznab search                  │
   │    GET search-api.torbox.app/torznab/api  │
   │                                           │
   ├─► TorBox API                              │
   │    POST api.torbox.app/v1/api/torrents/…  │
   │                                           │
   └─► Discord follow-up webhooks              │
        PATCH …/webhooks/{app}/{token}/…       │
                                                │
n8n / automation ──► /api/* (Bearer auth) ──────┘
```

## Implemented commands and routes

**Discord (guild-scoped slash commands)**

| Command | Description | Who can use it |
| --- | --- | --- |
| `/search query:<text>` | Search Voyager, show the top 5 results (title, size, seeders, category/source, magnet/hash availability) | Everyone |
| `/add magnet:<uri>` | Submit a magnet URI to TorBox | Users in `TORBOX_ALLOWED_USER_IDS` |
| `/status` | List the TorBox account's downloads (ephemeral) | Users in `TORBOX_ALLOWED_USER_IDS` |

**HTTP routes**

| Route | Description |
| --- | --- |
| `GET /` | Health check |
| `POST /discord/interactions` | Discord interaction webhook (Ed25519 verified) |
| `POST /api/search` | Internal search API (`{query, limit?}`) |
| `POST /api/torrents` | Internal add-magnet API (`{magnet}`) |
| `GET /api/torrents/:id` | Internal torrent status API |

`/search` answers Discord within the 3-second deadline using a deferred
response (type 5), then queries Voyager via `ctx.waitUntil` and edits the
original response through the follow-up webhook
(`PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`).
`/add` and `/status` defer ephemerally and complete the same way.

## Setup

### 1. Prerequisites

- Node.js 22+ and npm
- A Cloudflare account with Workers enabled
- A Discord account and a Discord application (below)
- A TorBox account with an API key (paid plan required for Voyager search;
  see "External API assumptions")

### 2. Discord application setup

1. Create an application at <https://discord.com/developers/applications>.
2. Note the **Application ID** and **Public Key** (General Information).
3. Create a bot user (Bot section) and copy the **Bot Token**.
4. Enable the bot in your guild with the `applications.commands` scope
   (OAuth2 → URL Generator → `bot` + `applications.commands`; no special bot
   permissions are needed for slash commands).
5. Note your guild (server) ID: Discord client → right-click server →
   "Copy Server ID" (requires Developer Mode).

### 3. Local configuration

```sh
npm install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (never commit it — it is git-ignored):

| Variable | Secret? | Used for |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | secret | Verifying Discord request signatures |
| `DISCORD_APPLICATION_ID` | id | Command registration script |
| `DISCORD_BOT_TOKEN` | secret | Command registration script only |
| `DISCORD_GUILD_ID` | id | Guild-scoped command registration |
| `TORBOX_API_KEY` | secret | TorBox API + Voyager `apikey` |
| `VOYAGER_API_KEY` | secret | Optional override if Voyager ever needs a distinct key (falls back to `TORBOX_API_KEY`) |
| `INTERNAL_API_TOKEN` | secret | Bearer token for `/api/*` (generate a long random string) |
| `TORBOX_ALLOWED_USER_IDS` | var | Comma-separated Discord user IDs allowed to run `/add` and `/status` |
| `UPSTREAM_TIMEOUT_MS` | var | Optional upstream timeout override (default `10000`) |

### 4. Cloudflare production configuration

Secrets (values never appear in the repo or in logs):

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put TORBOX_API_KEY
npx wrangler secret put INTERNAL_API_TOKEN
# optional: npx wrangler secret put VOYAGER_API_KEY
```

Non-secret vars live in `wrangler.jsonc` (`TORBOX_ALLOWED_USER_IDS`,
`UPSTREAM_TIMEOUT_MS`) and can be edited there or in the Cloudflare dashboard.

### 5. Register the Discord commands

```sh
npm run discord:register    # idempotent guild-scoped PUT
npm run discord:unregister  # removes all guild commands
```

Registration is guild-scoped (instant propagation) and safe to re-run. Global
commands are never touched.

### 6. Run and deploy

```sh
npm run dev        # local development via wrangler dev
npm run deploy     # deploy to Cloudflare
```

After deploying, set the **Interactions Endpoint URL** in the Discord
Developer Portal to:

```
https://<your-worker>.<your-subdomain>.workers.dev/discord/interactions
```

Discord verifies the endpoint with a signed PING, which the Worker answers
with PONG.

## Development

```sh
npm test -- --run     # run the test suite once
npm run typecheck     # strict TypeScript over src and test
npm run cf-typegen    # regenerate worker-configuration.d.ts after binding changes
npm run deploy -- --dry-run   # validate the deploy bundle locally
```

Project layout:

```
src/
  index.ts            route dispatch
  config.ts           env binding accessors (graceful degradation)
  discord/            types, Ed25519 verify, responses, follow-up client, router
  commands/           search, add, status, shared error mapping
  services/           voyager (Torznab XML), torbox (JSON API)
  routes/             discord webhook, internal API
  utils/              format, http (timeouts), errors, auth, magnet
  types/              torznab, torbox models
test/                 vitest + @cloudflare/vitest-pool-workers
scripts/              register-commands.mjs
```

## Testing

`npm test` runs Vitest inside a real Worker runtime
(`@cloudflare/vitest-pool-workers`). Outbound HTTP is mocked with
`fetchMock`; tests never contact Discord, Voyager, or TorBox. Signed Discord
requests are produced with a generated Ed25519 test key pair — production
verification is not weakened for tests.

Coverage includes: health/404s, unsigned/invalid-signature rejection, valid
PING→PONG, command routing, missing/malformed options, deferred responses and
follow-up edits, Voyager success/empty/500/429/timeout/malformed-XML, XML
entity-expansion rejection, formatting limits, magnet validation, TorBox
success/duplicate/auth-failure/timeout, and internal API authentication.

## Security model

- **Discord**: every interaction request must carry a valid Ed25519 signature
  over `timestamp + body` from the application's public key.
- **Internal API**: `Authorization: Bearer <INTERNAL_API_TOKEN>` with a
  constant-time comparison (SHA-256 pre-hashed before the compare loop).
- **TorBox authorization**: `/add` and `/status` are restricted to Discord
  user IDs in `TORBOX_ALLOWED_USER_IDS` and reply ephemerally.
- **No secret logging**: interaction tokens, bot tokens, API keys,
  authorization headers, full magnet URIs, and raw interaction payloads are
  never logged. Upstream error types never carry request URLs (which can
  contain credentials).
- **Mentions**: all bot messages set `allowed_mentions: { parse: [] }`;
  titles are sanitized and length-capped (Discord's 2000-char limit).
- **XML**: Voyager responses are parsed with a non-validating parser that
  performs no I/O; documents containing a DOCTYPE are rejected outright to
  prevent entity-expansion/XXE attacks.
- **Privacy**: Discord output shows magnet/hash *availability markers* only.
  Magnet URIs are exposed solely through the authenticated internal API.

## External API assumptions

Verified (2026-07-19):

- Discord interaction types/callback types, the 3-second initial-response
  deadline, 15-minute follow-up token validity, the follow-up edit endpoint,
  the 2000-character content limit, and `allowed_mentions` semantics — from
  the official Discord developer documentation.
- `GET https://search-api.torbox.app/torznab/api` exists (also
  `/newznab/api`) and requires the `apikey` and `t` query parameters — from
  the live service's public OpenAPI spec. Missing params → 422 JSON; invalid
  key → 429 JSON (`{"error":"Rate limit exceeded: 0 per 1 minute"}`).
- TorBox main API (`https://api.torbox.app/v1/api`): `POST
  /torrents/createtorrent` (multipart `magnet` field, Bearer auth) and `GET
  /torrents/mylist` shapes — from the official TorBox API documentation,
  including the `{success, error, detail, data}` envelope.

Not yet verified (needs a real TorBox API key):

- The exact success XML emitted by Voyager's Torznab endpoint. The adapter
  targets the standard Newznab/Torznab RSS shape (`rss > channel > item` with
  `torznab:attr` extensions) and treats every field as optional, so any
  compliant feed works; confirm the first real response before relying on
  specific attributes (e.g. `seeders`, `magneturl`).
- That the Voyager `apikey` is the TorBox account API key (strongly implied
  by TorBox docs; `VOYAGER_API_KEY` exists as an override if not).
- Whether TorBox `mylist` `progress` is 0–1 or 0–100; the bot normalizes
  both (`<= 1` is treated as a fraction).

## Internal API usage (n8n or other automation)

All routes require `Authorization: Bearer $INTERNAL_API_TOKEN`.

```sh
# Search
curl -X POST https://<worker>.workers.dev/api/search \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "blade runner", "limit": 5}'

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
- **"Search is not configured"**: set `TORBOX_API_KEY` (or `VOYAGER_API_KEY`).
- **Voyager returns 429**: the API key is invalid, or you are rate limited;
  the bot surfaces this as "rate limiting".
- **`/add` says "not authorized"**: add your Discord user ID to
  `TORBOX_ALLOWED_USER_IDS` (var, comma-separated).

## Remaining manual steps

1. Create the Discord application/guild and TorBox account (above).
2. Add real IDs and API keys to `.dev.vars`.
3. Add production secrets (`wrangler secret put …`) and review
   `wrangler.jsonc` vars.
4. Run `npm run discord:register`.
5. Run `npm run deploy`.
6. Enter the interactions endpoint URL in the Discord Developer Portal.
7. First real search: confirm Voyager's XML matches the tolerant parser's
   expectations (see "External API assumptions").
