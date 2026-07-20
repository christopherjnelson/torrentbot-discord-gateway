/**
 * Types for the TorBox main API (https://api.torbox.app/v1/api).
 *
 * Verified against the official TorBox API documentation
 * (https://api-docs.torbox.app, Postman collection) on 2026-07-19:
 * - All endpoints return the standard envelope below.
 * - Auth: `Authorization: Bearer <api_key>`; failures use 400/403/500 with
 *   a user-friendly `detail` message and a machine-readable `error` code.
 * - POST /torrents/createtorrent: multipart form, `magnet` or `file` field.
 * - GET /torrents/mylist: optional `id`, `offset`, `limit`, `bypass_cache`.
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
 * One entry of GET /torrents/mylist. Only fields this Worker uses are
 * modelled; the upstream payload contains more (files, paths, trackers),
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
	cached: boolean;
}
