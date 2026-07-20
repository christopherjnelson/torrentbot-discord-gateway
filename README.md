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
| `/search query:<text>` | Search Prowlarr, show the top 5 results (title, size, seeders, category/source, magnet/hash availability); results with valid info hashes include a select menu to add to TorBox. Selectable results are checked against TorBox's cache in one batch request and cached ones are marked with `⚡ Cached` | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/add magnet:<uri>` | Submit a magnet URI to TorBox | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |
| `/status` | List the TorBox account's downloads (ephemeral) | Members of guilds in `TORBOX_ALLOWED_GUILD_IDS` |

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

During `/search`, the selectable results' info hashes are also checked
against TorBox's `POST /torrents/checkcached` endpoint in a single batch
request. Results TorBox already holds are marked with a `⚡ Cached` badge in
the option description; uncached or unknown results are not labeled. The
check is **advisory only**: it does not add anything to the TorBox account,
and if TorBox is not configured or the cache check fails for any reason,
`/search` still returns the normal Prowlarr results without badges.

When an authorized member selects a result, the bot:

1. **Validates** the signed component payload, the requester binding (only
   the user who ran `/search` may use its menu), and the authorized-guild
   check. Failures answer ephemerally and leave the search menu untouched.
2. **Acknowledges** the interaction with `UPDATE_MESSAGE` (Discord callback
   type 7), which removes the select menu from the search results message
   without showing a loading state. The TorBox work runs in the background via
   `ctx.waitUntil`.
3. **Submits** the magnet to TorBox. If TorBox reports the item already
   exists (`DUPLICATE_ITEM`), the bot locates the existing torrent by its
   info hash (the stable documented identifier, never by title) and
   continues.
4. **Polls** TorBox for readiness in a short bounded window (see
   *TorBox polling* below).
5. **Reports** the outcome in an ephemeral followup message.

Component interactions are signed with HMAC-SHA-256 to prevent tampering and
bind the selection to the original requester.

### TorBox download flow

A selection produces one of these ephemeral responses:

**Cached or quickly ready**

```
Added to TorBox.

**Backrooms (2026) [1080p]**
Ready to download:
[Download file](https://…) — `Backrooms.2026.1080p.mkv` (1.4 GiB)
```

For a multi-file torrent the bot returns a whole-torrent zip archive link
instead, since TorBox's `zip_link` requestdl option is officially documented
and avoids guessing at individual files:

```
Added to TorBox.

**Some.Season.Pack.2026**
Ready to download (12 files):
[Download archive (zip)](https://…)
```

**Still processing** (torrent added but not ready within the bounded window)

```
Added to TorBox.

**Backrooms (2026) [1080p]**
TorBox is still processing this torrent (ID `42`). Use `/status` to check it later.
```

**Failure** (added but a link could not be generated yet)

```
The torrent was added, but TorrentBot could not generate a download link yet.
Use `/status` to check it later.
```

All of these responses are **ephemeral** — the download link is never placed in
the public search results message and is only ever shown to the requester. The
generated TorBox download URL is a temporary CDN link (valid ~3 hours for
starting a download) and is never logged.

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
| `TORBOX_ALLOWED_GUILD_IDS` | secret | Comma-separated Discord guild (server) IDs whose members may run `/search`, `/add`, `/status`, and the search-result selection flow (each entry must be a snowflake-style decimal string; missing/empty/malformed denies all Discord TorBox access). Treated as a secret so real guild IDs stay out of tracked files |
| `UPSTREAM_TIMEOUT_MS` | var | Optional upstream timeout override (default `10000`) |
| `TORBOX_POLL_INTERVAL_MS` | var | Optional delay between TorBox readiness polls after a selection (default `2500`, range 250–10000) |
| `TORBOX_POLL_MAX_ATTEMPTS` | var | Optional cap on TorBox readiness polls after a selection (default `7`, range 1–20) |

### 5. Cloudflare production configuration

Secrets (values never appear in the repo or in logs):

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put PROWLARR_API_KEY
npx wrangler secret put TORBOX_API_KEY
npx wrangler secret put INTERNAL_API_TOKEN
npx wrangler secret put COMPONENT_SIGNING_SECRET
npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS
```

The `COMPONENT_SIGNING_SECRET` is used to sign and verify Discord component
interaction payloads (the select menu in `/search` results). Generate it with:

```sh
openssl rand -hex 32
```

`TORBOX_ALLOWED_GUILD_IDS` is a comma-separated list of Discord guild (server)
IDs; every member of an approved guild can use `/search`, `/add`, `/status`,
and the search-result selection flow. Enter multiple IDs as a single
comma-separated value (e.g. `123456789012345678,987654321098765432`). Each
entry must be a snowflake-style decimal string; missing/empty/malformed
configuration denies all Discord TorBox access. It is a Worker secret (not a
`wrangler.jsonc` var) so real guild IDs never land in tracked files. Direct
messages are not supported.

Non-secret vars live in `wrangler.jsonc` (`PROWLARR_URL`,
`UPSTREAM_TIMEOUT_MS`, `TORBOX_POLL_INTERVAL_MS`, `TORBOX_POLL_MAX_ATTEMPTS`)
and can be edited there or in the Cloudflare dashboard.

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
- **TorBox authorization**: `/search`, `/add`, and `/status` are restricted
  to members of Discord guilds listed in `TORBOX_ALLOWED_GUILD_IDS` and
  reply ephemerally. Direct messages are rejected. Every member of an
  approved guild may run these commands.
- **Component interaction authorization**: select menu interactions from
  `/search` results are restricted to the original requester (verified via
  HMAC-SHA-256 signed payloads) and must originate from an authorized
  guild. A valid signed component used in a DM or another server is
  rejected. The signing secret is `COMPONENT_SIGNING_SECRET`. Payloads
  expire after 15 minutes. The original requester binding is preserved:
  even within an authorized guild, only the user who created a particular
  search menu may select from it.
- **No secret logging**: interaction tokens, bot tokens, API keys,
  authorization headers, full magnet URIs, generated download URLs, and raw
  interaction payloads are never logged. Upstream error types never carry
  request URLs (which can contain credentials).
- **Prowlarr proxy URLs**: Prowlarr rewrites `downloadUrl`/`magnetUrl` in
  search responses into proxy URLs that embed the Prowlarr API key
  (`/{indexerId}/download?apikey=…`). The adapter never propagates them:
  magnets are synthesized from the info hash (or passed through only when
  already a raw `magnet:` URI), and result links come from the un-proxied
  `infoUrl` field.
- **TorBox download links**: only `https:` URLs returned by TorBox are
  accepted; the documented permalink form (which embeds the TorBox API key
  in the URL) is never used. Links are delivered only in ephemeral
  followup messages to the requester and never appear in the public search
  results message.
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
  /torrents/createtorrent` (multipart `magnet` field, Bearer auth),
  `GET /torrents/mylist` (params `id`, `offset`, `limit`, `bypass_cache`;
  with `id` the docs state the response "will return an object rather than
  list", which the bot tolerates either shape; `bypass_cache` bypasses the
  600-second server-side list cache), and `GET /torrents/requestdl` (params
  `token` (API key), `torrent_id`, `file_id` (optional if `zip_link`),
  `zip_link` ("required if no file_id; takes precedence over file_id"),
  `user_ip`, `redirect`, `append_name`; `data` is a temporary CDN URL string)
  — from the official TorBox API documentation (Postman collection at
  api-docs.torbox.app and the live OpenAPI spec at api.torbox.app/openapi.json),
  including the `{success, error, detail, data}` envelope, the documented
  download states, and `download_finished` as the supported completion signal.
  Also verified `POST /torrents/checkcached` (JSON body `{ hashes: [...] }`,
  Bearer auth, `format` query param defaulting to `object`): `data` is a map
  keyed by hash and a hash present in `data` means it is cached, while
  uncached/unknown hashes are simply absent (the documented "Success Uncached"
  example returns `data: null`). Hashes are matched case-insensitively.
- Discord message-component interactions: `UPDATE_MESSAGE` (callback type 7)
  edits the message the component was attached to (used to remove the search
  select menu), and interaction followups (`POST /webhooks/{app}/{token}` with
  the `EPHEMERAL` flag) deliver the final ephemeral result — from the official
  Discord developer documentation.

Not yet verified (needs a real TorBox API key):

- Whether TorBox `mylist` `progress` is 0–1 or 0–100; the bot normalizes
  both (`<= 1` is treated as a fraction).
- Whether `download_state: "completed"` truly differs from
  `download_finished: true` in practice; per the docs the bot relies only on
  `download_finished`.

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
- **`/add` says "TorrentBot is not enabled for this server"**: the
  interaction's guild is not listed in `TORBOX_ALLOWED_GUILD_IDS` (secret,
  comma-separated snowflake IDs). Add the guild ID with
  `npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS` and redeploy. Direct
  messages are not supported.
- **"TorrentBot authorization is not configured correctly"**:
  `TORBOX_ALLOWED_GUILD_IDS` is missing, empty, or contains a malformed
  (non-snowflake) entry; the bot fails closed. Set a valid comma-separated
  value with `npx wrangler secret put TORBOX_ALLOWED_GUILD_IDS` and redeploy.

## Remaining manual steps

1. Create the Discord application/guild, Prowlarr instance, and TorBox
   account (above).
2. Add real IDs and API keys to `.dev.vars`.
3. Add production secrets (`wrangler secret put …`, including
   `TORBOX_ALLOWED_GUILD_IDS`) and review `wrangler.jsonc` vars
   (`PROWLARR_URL` in particular).
4. Run `npm run discord:register` (re-run it after pulling changes that
   touch `scripts/register-commands.mjs`).
5. Run `npm run deploy`.
6. Enter the interactions endpoint URL in the Discord Developer Portal.
7. First real search: run `/search ubuntu` in Discord and confirm the Worker
   returns Prowlarr results (the Prowlarr UI's History → Search log shows
   the incoming API search).

## Current limitations

- **Bounded readiness check only**: the selection flow polls TorBox for at
  most ~15–20 seconds. If a torrent is not ready within that window the bot
  tells the user it is still processing and stops — it does not persist any
  state and does **not** notify the user later when the torrent finishes.
  Use `/status` to check items still processing. Persistent background
  monitoring (KV, D1, Durable Objects, Queues, Workflows, cron, or external
  databases/n8n) is intentionally out of scope.
- **Multi-file torrents**: a multi-file torrent always returns a whole-torrent
  zip archive link. Individual-file selection within a multi-file torrent
  (largest non-sample media file, sample/NFO/subtitle exclusion) is not
  implemented, because the documented TorBox `zip_link` archive option is
  available and avoids guessing at individual files.
- **Temporary links**: generated TorBox download URLs are temporary CDN links
  (~3 hours for starting a download), as documented. They are not persisted
  by the bot.
- The bot does not monitor download progress across requests.
