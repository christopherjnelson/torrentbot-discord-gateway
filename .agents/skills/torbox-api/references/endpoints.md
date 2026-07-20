# TorBox endpoints used by this repository

Base URL: `https://api.torbox.app/v1/api` (`TORBOX_API_BASE` in
`src/services/torbox.ts`). `[impl+tests]` = verified by implementation +
passing tests; `[docs 2026-07-20]` = verified against official docs/OpenAPI
on 2026-07-20.

| Endpoint | Method | Path | Params | Auth | Verified |
| --- | --- | --- | --- | --- | --- |
| Create torrent | POST | `/torrents/createtorrent` | multipart form field `magnet` | `Authorization: Bearer <key>` | `[impl+tests]` `[docs 2026-07-20]` |
| List torrents | GET | `/torrents/mylist` | `id?`, `offset?`, `limit?`, `bypass_cache?` (all query) | `Authorization: Bearer <key>` | `[impl+tests]` `[docs 2026-07-20]` |
| Get torrent by id | GET | `/torrents/mylist` | `id`, `bypass_cache=true` (query) | `Authorization: Bearer <key>` | `[impl+tests]` `[docs 2026-07-20]` |
| Check cache | POST | `/torrents/checkcached` | `format=object` (query); JSON body `{ hashes: [...] }` | `Authorization: Bearer <key>` | `[impl+tests]` `[docs 2026-07-20]` |
| Request download link | GET | `/torrents/requestdl` | `token` (API key), `torrent_id`, and either `file_id` or `zip_link=true` | `Authorization: Bearer <key>` **and** `token` query param | `[impl+tests]` `[docs 2026-07-20]` |

Notes:

- `createtorrent` uses a **multipart form** body with a single `magnet` field
  (not JSON). `[impl+tests]`
- `mylist` with `id` set returns an **object, not a list**, per the docs; the
  implementation tolerates both the object and array shapes. `[docs 2026-07-20]` `[impl+tests]`
- `mylist` list data is **cached server-side for 600 seconds**, so any
  readiness polling must send `bypass_cache=true`. `[docs 2026-07-20]` `[impl+tests]`
- `checkcached` sends hashes in the **request body** (never the URL) and uses
  `format=object` so `data` is a map keyed by hash. `[impl+tests]`
- `requestdl` is the only endpoint that puts the API key in the URL (the
  required `token` query param); the Bearer header is sent as well. The
  documented `redirect=true` permalink form (which embeds the API key
  permanently in the URL) is **never** used. `[docs 2026-07-20]` `[impl+tests]`

## Endpoints deliberately NOT used

- `search-api.torbox.app` (Voyager/Torznab) — search goes through Prowlarr.
- The `requestdl` permalink / `redirect=true` form — embeds the API key.
- Any `createtorrent` `file` upload field — only the `magnet` field is used.
