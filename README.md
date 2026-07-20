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
   ├─► Prowlarr API (search)                   │
   │    GET prowlarr.chris.guru/api/v1/search  │
   │                                           │
   ├─► TorBox API (add/status)                 │
   │    POST api.torbox.app/v1/api/torrents/…  │
   │                                           │
   └─► Discord follow-up webhooks              │
        PATCH …/webhooks/{app}/{token}/…       │
                                                │
n8n / automation ──► /api/* (Bearer auth) ──────┘
```

Search goes directly to Prowlarr; torrent management goes directly to TorBox.
The TorBox Voyager/Torznab endpoint (`search-api.torbox.app`) is **not** used
and no Voyager API key is required.

## Implemented commands and routes

**Discord (guild-scoped slash commands)**

| Command | Description | Who can use it |
| --- | --- | --- |
| `/search query:<text>` | Search Prowlarr, show the top 5 results (title, size, seeders, category/source, magnet/hash availability); results with valid info hashes include a select menu to add to TorBox | Everyone |
| `/add magnet:<uri>` | Submit a magnet URI to TorBox | Users in `TORBOX_ALLOWED_USER_IDS` |
| `/status` | List the TorBox account's downloads (ephemeral) | Users in `TORBOX_ALLOWED_USER_IDS` |

**HTTP routes**

| Route | Description |
| --- | --- |
| `GET /` | Health check |
| `POST /discord/interactions` | Discord interaction webhook (Ed25519 verified) |
| `POST /api/search` | Internal search API (`{query, limit?}`), backed by Prowlarr |
| `POST /api/torrents` | Internal add-magnet API (`{magnet}`), backed by TorBox |
| `GET /api/torrents/:id` | Internal torrent status API, backed by TorBox |

`/search` answers Discord within the 3-second deadline using a deferred
response (type 5), then queries Prowlarr via `ctx.waitUntil` and edits the
original response through the follow-up webhook
(`PATCH /webhooks/{application.id}/{interaction.token}/messages/@original`).
`/add` and `/status` defer ephemerally and complete the same way.

When `/search` returns results with valid info hashes, it also includes a
Discord select menu component. The original requester can use this menu to
submit a selected result to TorBox without manually copying the magnet URI.
The menu is disabled after a successful submission. Component interactions are
signed with HMAC-SHA-256 to prevent tampering and bind the selection to the
original requester.

## Setup

### 1. Prerequisites

- Node.js 22+ and npm
- A Cloudflare account with Workers enabled
- A Discord account and a Discord application (below)
- A running Prowlarr instance reachable from Cloudflare (this deployment uses
  `https://prowlarr.chris.guru`) with its API key
- A TorBox account with an API key (only needed for `/add` and `/status`)

### 2. Discord application setup

1. Create an application at <https://discord.com/developers/applications>.
2. Note the **Application ID** and **Public Key** (General Information).
3. Create a bot user (Bot section) and copy the **Bot Token**.
4. Enable the bot in your guild with the `applications.commands` scope
   (OAuth2 → URL Generator → `bot` + `applications.commands`; no special bot
   permissions are needed for slash commands).
5. Note your guild (server) ID: Discord client → right-click server →
   "Copy Server ID" (requires Developer Mode).

### 3. Prowlarr setup

1. In Prowlarr, add and test your indexers (Settings → Indexers) and confirm
   a manual search in the Prowlarr UI returns results.
2. Copy the API key: **Settings → General → Security → API Key**.
3. Verify the instance independently (replace host and key):

```sh
curl -sS "https://prowlarr.chris.guru/api/v1/search?query=ubuntu&limit=2" \
  -H "X-Api-Key: $PROWLARR_API_KEY" | head -c 600
```

A valid key returns a JSON array of releases (`title`, `size`, `seeders`,
`leechers`, `indexer`, `infoHash`, …). A missing/invalid key returns `401`.
`https://prowlarr.chris.guru/ping` answers `{"status":"OK"}` without a key
and is a quick liveness check.

### 4. Local configuration

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
| `PROWLARR_API_KEY` | secret | Prowlarr search (`X-Api-Key` header) |
| `TORBOX_API_KEY` | secret | TorBox API (`/add`, `/status`, `/api/torrents`) |
| `INTERNAL_API_TOKEN` | secret | Bearer token for `/api/*` (generate a long random string) |
| `COMPONENT_SIGNING_SECRET` | secret | HMAC-SHA-256 signing for Discord component interactions (generate with `openssl rand -hex 32`) |
| `PROWLARR_URL` | var | Prowlarr base URL (set in `wrangler.jsonc`; `.dev.vars` overrides locally) |
| `TORBOX_ALLOWED_USER_IDS` | var | Comma-separated Discord user IDs allowed to run `/add` and `/status` |
| `UPSTREAM_TIMEOUT_MS` | var | Optional upstream timeout override (default `10000`) |

### 5. Cloudflare production configuration

Secrets (values never appear in the repo or in logs):

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put PROWLARR_API_KEY
npx wrangler secret put TORBOX_API_KEY
npx wrangler secret put INTERNAL_API_TOKEN
npx wrangler secret put COMPONENT_SIGNING_SECRET
```

The `COMPONENT_SIGNING_SECRET` is used to sign and verify Discord component
interaction payloads (the select menu in `/search` results). Generate it with:

```sh
openssl rand -hex 32
```

Non-secret vars live in `wrangler.jsonc` (`PROWLARR_URL`,
`TORBOX_ALLOWED_USER_IDS`, `UPSTREAM_TIMEOUT_MS`) and can be edited there or
in the Cloudflare dashboard.

### 6. Register the Discord commands

```sh
npm run discord:register    # idempotent guild-scoped PUT
npm run discord:unregister  # removes all guild commands
```

Registration is guild-scoped (instant propagation) and safe to re-run. Global
commands are never touched.

### 7. Run and deploy

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
  commands/           search, add, status, component (select menu handler), shared error mapping
  services/           prowlarr (search JSON API), torbox (JSON API)
  routes/             discord webhook, internal API
  utils/              format, http (timeouts), errors, auth, magnet, signing (HMAC)
  types/              search, torbox models
test/                 vitest + @cloudflare/vitest-pool-workers
scripts/              register-commands.mjs
```

## Testing

`npm test` runs Vitest inside a real Worker runtime
(`@cloudflare/vitest-pool-workers`). Outbound HTTP is mocked with
`fetchMock`; tests never contact Discord, Prowlarr, or TorBox. Signed Discord
requests are produced with a generated Ed25519 test key pair — production
verification is not weakened for tests.

Coverage includes: health/404s, unsigned/invalid-signature rejection, valid
PING→PONG, command routing, missing/malformed options, deferred responses and
follow-up edits, Prowlarr success/empty/401/500/timeout/malformed-JSON, URL
and `X-Api-Key` header construction, credential-bearing proxy-URL rejection,
deterministic ordering and limits, formatting limits, magnet validation,
TorBox success/duplicate/auth-failure/timeout, and internal API
authentication.

## Security model

- **Discord**: every interaction request must carry a valid Ed25519 signature
  over `timestamp + body` from the application's public key.
- **Internal API**: `Authorization: Bearer <INTERNAL_API_TOKEN>` with a
  constant-time comparison (SHA-256 pre-hashed before the compare loop).
- **TorBox authorization**: `/add` and `/status` are restricted to Discord
  user IDs in `TORBOX_ALLOWED_USER_IDS` and reply ephemerally.
- **Component interaction authorization**: select menu interactions from
  `/search` results are restricted to the original requester (verified via
  HMAC-SHA-256 signed payloads) and require the user to be in
  `TORBOX_ALLOWED_USER_IDS`. The signing secret is
  `COMPONENT_SIGNING_SECRET`. Payloads expire after 15 minutes.
- **No secret logging**: interaction tokens, bot tokens, API keys,
  authorization headers, full magnet URIs, and raw interaction payloads are
  never logged. Upstream error types never carry request URLs (which can
  contain credentials).
- **Prowlarr proxy URLs**: Prowlarr rewrites `downloadUrl`/`magnetUrl` in
  search responses into proxy URLs that embed the Prowlarr API key
  (`/{indexerId}/download?apikey=…`). The adapter never propagates them:
  magnets are synthesized from the info hash (or passed through only when
  already a raw `magnet:` URI), and result links come from the un-proxied
  `infoUrl` field.
- **Mentions**: all bot messages set `allowed_mentions: { parse: [] }`;
  titles are sanitized and length-capped (Discord's 2000-char limit).
- **Privacy**: Discord output shows magnet/hash *availability markers* only.
  Magnet URIs are exposed solely through the authenticated internal API.
- **Component payloads**: Discord component values and custom_ids are treated
  as untrusted input. Info hashes from select menu options are validated
  (40-character hexadecimal) before use. The HMAC signature binds the
  interaction to the original requester and prevents tampering.

## External API assumptions

Verified (2026-07-19):

- Discord interaction types/callback types, the 3-second initial-response
  deadline, 15-minute follow-up token validity, the follow-up edit endpoint,
  the 2000-character content limit, and `allowed_mentions` semantics — from
  the official Discord developer documentation.
- Prowlarr search: `GET /api/v1/search` with query params `query`, `type`,
  `indexerIds`, `categories`, `limit`, `offset`, authenticated via the
  `X-Api-Key` header — from the official Prowlarr source
  (`SearchController.cs`, `SearchResource.cs`, `ReleaseResource.cs`,
  `AuthenticationBuilderExtensions.cs`) and confirmed against the live
  instance (`/ping` → `{"status":"OK"}`; unauthenticated `/api/v1/search` →
  401). Response items are normalized tolerantly: only `title` is required;
  `size`, `seeders`, `leechers`, `categories`, `indexer`, `infoUrl`,
  `infoHash`, `publishDate`, and `magnetUrl` are all optional.
- TorBox main API (`https://api.torbox.app/v1/api`): `POST
  /torrents/createtorrent` (multipart `magnet` field, Bearer auth) and `GET
  /torrents/mylist` shapes — from the official TorBox API documentation,
  including the `{success, error, detail, data}` envelope.

Not yet verified (needs a real TorBox API key):

- Whether TorBox `mylist` `progress` is 0–1 or 0–100; the bot normalizes
  both (`<= 1` is treated as a fraction).

## Internal API usage (n8n or other automation)

All routes require `Authorization: Bearer $INTERNAL_API_TOKEN`.

```sh
# Search (Prowlarr)
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
- **"Search is not configured"**: set `PROWLARR_URL` (var) and
  `PROWLARR_API_KEY` (secret).
- **"The upstream service rejected the configured credentials"**: the
  `PROWLARR_API_KEY` is wrong or was rotated; copy the current key from
  Prowlarr → Settings → General → Security → API Key.
- **`/add` says "not authorized"**: add your Discord user ID to
  `TORBOX_ALLOWED_USER_IDS` (var, comma-separated).

## Remaining manual steps

1. Create the Discord application/guild, Prowlarr instance, and TorBox
   account (above).
2. Add real IDs and API keys to `.dev.vars`.
3. Add production secrets (`wrangler secret put …`) and review
   `wrangler.jsonc` vars (`PROWLARR_URL` in particular).
4. Run `npm run discord:register` (re-run it after pulling changes that
   touch `scripts/register-commands.mjs`).
5. Run `npm run deploy`.
6. Enter the interactions endpoint URL in the Discord Developer Portal.
7. First real search: run `/search ubuntu` in Discord and confirm the Worker
   returns Prowlarr results (the Prowlarr UI's History → Search log shows
   the incoming API search).

## Current limitations

- **Task 1 (this task)**: The select menu in `/search` results only submits
  torrents to TorBox. Polling for download completion and generating download
  links are deferred to Task 2.
- The bot does not currently monitor download progress or notify when downloads
  complete.
- Download links are not yet generated. Users must check their TorBox account
  for completed downloads.
