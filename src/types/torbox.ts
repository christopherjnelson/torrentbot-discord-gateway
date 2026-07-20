/**
 * Types for the TorBox main API (https://api.torbox.app/v1/api).
 *
 * Verified against the official TorBox API documentation
 * (https://api-docs.torbox.app Postman collection and the live OpenAPI spec
 * at https://api.torbox.app/openapi.json) on 2026-07-20:
 * - All endpoints return the standard envelope below.
 * - Auth: `Authorization: Bearer <api_key>`; failures use 400/403/500 with
 *   a user-friendly `detail` message and a machine-readable `error` code.
 * - POST /torrents/createtorrent: multipart form, `magnet` or `file` field.
 * - GET /torrents/mylist: optional `id`, `offset`, `limit`, `bypass_cache`.
 *   With `id`, docs state data "will return an object rather than list" —
 *   consumers must tolerate both shapes. List data is otherwise cached for
 *   600 seconds, so readiness polling must pass `bypass_cache=true`.
 * - Readiness: `download_state: "completed"` is documented as "do not use
 *   this for download completion status"; `download_finished` is the
 *   supported completion signal.
 * - GET /torrents/requestdl: `token` (API key, query param), `torrent_id`,
 *   optional `file_id` ("optional if using zip_link") and `zip_link`
 *   ("required if no file_id; takes precedence over file_id"). `data` is a
 *   temporary CDN URL string (valid ~3 hours for starting downloads). The
 *   documented permalink form embeds the API key in the URL and is never
 *   used here.
 */

/** Standard TorBox response envelope. */
export interface TorboxResponse<T> {
	success: boolean;
	error: string | null;
	detail: string;
	data: T;
}

/** data payload of POST /torrents/createtorrent. */
export interface TorboxCreateTorrentData {
	hash: string;
	torrent_id: number;
	auth_id: string;
}

/**
 * One downloadable file inside a torrent (GET /torrents/mylist `files[]`).
 * Only the fields needed to request a download link and describe the file
 * are modelled; upstream also sends md5/hash/s3_path/absolute_path/
 * opensubtitles_hash, which are private and deliberately never read.
 */
export interface TorboxFile {
	id: number;
	name: string;
	size: number;
}

/**
 * One entry of GET /torrents/mylist. Only fields this Worker uses are
 * modelled; the upstream payload contains more (magnet, paths, trackers),
 * which is deliberately never read, logged, or returned.
 */
export interface TorboxTorrent {
	id: number;
	hash: string;
	name: string;
	size: number;
	active: boolean;
	created_at: string;
	updated_at: string;
	download_state: string;
	seeds: number;
	peers: number;
	progress: number;
	download_speed: number;
	upload_speed: number;
	download_finished: boolean;
	download_present: boolean;
	cached: boolean;
	files: TorboxFile[];
}
