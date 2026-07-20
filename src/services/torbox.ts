import type {
	TorboxCreateTorrentData,
	TorboxFile,
	TorboxResponse,
	TorboxTorrent,
} from "../types/torbox";
import {
	UpstreamApiError,
	UpstreamParseError,
	UpstreamStatusError,
} from "../utils/errors";
import { fetchText } from "../utils/http";
import { sanitizeInline } from "../utils/format";

/**
 * Typed boundary for the TorBox main API.
 * Endpoint shapes verified against official docs (see types/torbox.ts).
 *
 * Security rules:
 * - The API key travels only in the Authorization header and, for the
 *   requestdl endpoint (which documents a required `token` query parameter),
 *   in the request URL query string. Request URLs are never logged and the
 *   normalized error types never carry URLs.
 * - Full magnet URIs are accepted as input but never logged or echoed.
 * - Generated download URLs are returned to callers but never logged here.
 */

export const TORBOX_API_BASE = "https://api.torbox.app/v1/api";
const TORBOX_SERVICE = "torbox" as const;

/** A valid 40-character hexadecimal BitTorrent v1 info hash. */
const INFO_HASH_PATTERN = /^[a-fA-F0-9]{40}$/;

export interface TorboxClientOptions {
	apiKey: string;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseEnvelope(body: string): TorboxResponse<unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new UpstreamParseError(TORBOX_SERVICE, "returned invalid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.success !== "boolean") {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned an unexpected JSON structure",
		);
	}
	return {
		success: parsed.success,
		error: asString(parsed.error) ?? null,
		detail: asString(parsed.detail) ?? "",
		data: parsed.data,
	};
}

/**
 * Throw the appropriate typed error for a failed TorBox call, preferring the
 * upstream's sanitized user-facing detail when available.
 */
function throwForFailure(
	envelope: TorboxResponse<unknown> | null,
	status: number,
): never {
	if (envelope) {
		const detail =
			sanitizeInline(envelope.detail, 200) || "request failed";
		throw new UpstreamApiError(TORBOX_SERVICE, detail, {
			status,
			code: envelope.error,
		});
	}
	throw new UpstreamStatusError(TORBOX_SERVICE, status);
}

/**
 * Parse a response body into an envelope, tolerating non-JSON bodies on
 * non-200 statuses (which become plain status errors instead).
 */
function parseEnvelopeLenient(body: string, status: number): TorboxResponse<unknown> | null {
	try {
		return parseEnvelope(body);
	} catch (error) {
		if (status === 200) {
			throw error;
		}
		return null;
	}
}

/**
 * Submit a magnet URI to TorBox.
 * POST /torrents/createtorrent (multipart form, `magnet` field).
 */
export async function createTorrent(
	magnetUri: string,
	options: TorboxClientOptions,
): Promise<TorboxCreateTorrentData> {
	const form = new FormData();
	form.append("magnet", magnetUri);

	const { status, body } = await fetchText(`${TORBOX_API_BASE}/torrents/createtorrent`, {
		service: TORBOX_SERVICE,
		method: "POST",
		headers: { authorization: `Bearer ${options.apiKey}` },
		body: form,
		timeoutMs: options.timeoutMs,
	});

	const envelope = parseEnvelopeLenient(body, status);

	if (status !== 200 || !envelope || !envelope.success) {
		throwForFailure(envelope, status);
	}

	const data = envelope.data;
	if (
		!isRecord(data) ||
		asNumber(data.torrent_id) === undefined ||
		asString(data.hash) === undefined
	) {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned an unexpected create-torrent payload",
		);
	}

	return {
		hash: data.hash as string,
		torrent_id: data.torrent_id as number,
		auth_id: asString(data.auth_id) ?? "",
	};
}

export interface ListTorrentsOptions extends TorboxClientOptions {
	/** Fetch a single torrent by id (mylist?id=N). */
	id?: number;
	limit?: number;
	offset?: number;
	/**
	 * Bypass TorBox's 600-second server-side list cache. Required when
	 * polling for fresh readiness state (verified in the official docs).
	 */
	bypassCache?: boolean;
}

function normalizeFile(value: unknown): TorboxFile | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = asNumber(value.id);
	const name = asString(value.name);
	if (id === undefined || name === undefined) {
		return null;
	}
	return {
		id,
		name,
		size: asNumber(value.size) ?? 0,
	};
}

function normalizeTorrent(value: unknown): TorboxTorrent | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = asNumber(value.id);
	const name = asString(value.name);
	if (id === undefined || name === undefined) {
		return null;
	}
	return {
		id,
		hash: asString(value.hash) ?? "",
		name,
		size: asNumber(value.size) ?? 0,
		active: value.active === true,
		created_at: asString(value.created_at) ?? "",
		updated_at: asString(value.updated_at) ?? "",
		download_state: asString(value.download_state) ?? "unknown",
		seeds: asNumber(value.seeds) ?? 0,
		peers: asNumber(value.peers) ?? 0,
		progress: asNumber(value.progress) ?? 0,
		download_speed: asNumber(value.download_speed) ?? 0,
		upload_speed: asNumber(value.upload_speed) ?? 0,
		download_finished: value.download_finished === true,
		download_present: value.download_present === true,
		cached: value.cached === true,
		files: Array.isArray(value.files)
			? value.files
					.map(normalizeFile)
					.filter((file): file is TorboxFile => file !== null)
			: [],
	};
}

/**
 * List the account's torrents.
 * GET /torrents/mylist (optional id/offset/limit/bypass_cache).
 */
export async function listTorrents(
	options: ListTorrentsOptions,
): Promise<TorboxTorrent[]> {
	const url = new URL(`${TORBOX_API_BASE}/torrents/mylist`);
	if (options.id !== undefined) {
		url.searchParams.set("id", String(options.id));
	}
	if (options.limit !== undefined) {
		url.searchParams.set("limit", String(options.limit));
	}
	if (options.offset !== undefined) {
		url.searchParams.set("offset", String(options.offset));
	}
	if (options.bypassCache === true) {
		url.searchParams.set("bypass_cache", "true");
	}

	const { status, body } = await fetchText(url.toString(), {
		service: TORBOX_SERVICE,
		headers: { authorization: `Bearer ${options.apiKey}` },
		timeoutMs: options.timeoutMs,
	});

	const envelope = parseEnvelopeLenient(body, status);

	if (status !== 200 || !envelope || !envelope.success) {
		throwForFailure(envelope, status);
	}

	if (!Array.isArray(envelope.data)) {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned an unexpected torrent list payload",
		);
	}

	return envelope.data
		.map(normalizeTorrent)
		.filter((torrent): torrent is TorboxTorrent => torrent !== null);
}

/**
 * Fetch a single torrent by id, always with fresh (non-cached) data.
 * Returns null when the torrent does not exist on the account.
 *
 * The official docs state mylist?id=N "will return an object rather than
 * list"; both the object and array shapes (and an ITEM_NOT_FOUND failure)
 * are tolerated and normalized.
 */
export async function getTorrentById(
	id: number,
	options: TorboxClientOptions,
): Promise<TorboxTorrent | null> {
	const url = new URL(`${TORBOX_API_BASE}/torrents/mylist`);
	url.searchParams.set("id", String(id));
	url.searchParams.set("bypass_cache", "true");

	const { status, body } = await fetchText(url.toString(), {
		service: TORBOX_SERVICE,
		headers: { authorization: `Bearer ${options.apiKey}` },
		timeoutMs: options.timeoutMs,
	});

	const envelope = parseEnvelopeLenient(body, status);

	if (status !== 200 || !envelope || !envelope.success) {
		// A missing torrent is reported as ITEM_NOT_FOUND (docs show HTTP 404
		// with a quirky success:true envelope); normalize it to null.
		if (
			envelope &&
			(envelope.error === "ITEM_NOT_FOUND" || status === 404)
		) {
			return null;
		}
		throwForFailure(envelope, status);
	}

	const data = envelope.data;
	if (data === null || data === undefined) {
		return null;
	}
	if (Array.isArray(data)) {
		return (
			data
				.map(normalizeTorrent)
				.filter(
					(torrent): torrent is TorboxTorrent => torrent !== null,
				)
				.find((torrent) => torrent.id === id) ?? null
		);
	}
	const torrent = normalizeTorrent(data);
	return torrent !== null && torrent.id === id ? torrent : null;
}

/**
 * Find an existing torrent by its info hash (case-insensitive), using fresh
 * data. Used to recover the torrent id when createtorrent reports
 * DUPLICATE_ITEM. Returns null when no matching torrent exists.
 */
export async function findTorrentByHash(
	hash: string,
	options: TorboxClientOptions,
): Promise<TorboxTorrent | null> {
	let torrents: TorboxTorrent[];
	try {
		torrents = await listTorrents({ ...options, bypassCache: true });
	} catch (error) {
		if (
			error instanceof UpstreamApiError &&
			error.code === "ITEM_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
	const needle = hash.toLowerCase();
	return (
		torrents.find((torrent) => torrent.hash.toLowerCase() === needle) ?? null
	);
}

/**
 * Check which of the given info hashes are already cached on TorBox.
 * POST /torrents/checkcached (JSON body `{ hashes: [...] }`, format=object).
 *
 * Verified behavior (official TorBox OpenAPI spec + the Postman
 * collection at api-docs.torbox.app, 2026-07-20):
 * - Auth is the API key in the `Authorization: Bearer …` header (same as
 *   every other endpoint).
 * - The batch endpoint accepts the hashes as a JSON `{ hashes: [...] }`
 *   body and a `format` query parameter (`"object"` default, `"list"`).
 * - With `format=object`, `data` is a map keyed by hash; a hash present in
 *   `data` IS cached. Uncached/unknown hashes are simply absent — the
 *   documented "Success Uncached" example returns `data: null`.
 * - Hashes are matched case-insensitively (lowercased here and on lookup).
 * - Empty input makes no request and returns an empty set.
 *
 * Security: hashes travel in the request body (never the URL), and the
 * API key travels only in the Authorization header. The request URL, the
 * raw response, and individual hashes are never logged here; thrown
 * errors are the normalized Upstream* types, which never carry URLs,
 * hashes, or credentials.
 *
 * Throws Upstream* errors on HTTP/auth/parse failures; the caller is
 * expected to degrade gracefully (cache status is advisory).
 */
export async function checkTorrentCache(
	infoHashes: readonly string[],
	options: TorboxClientOptions,
): Promise<Set<string>> {
	const normalized = new Set<string>();
	for (const raw of infoHashes) {
		if (typeof raw !== "string") {
			continue;
		}
		const hash = raw.trim().toLowerCase();
		if (INFO_HASH_PATTERN.test(hash)) {
			normalized.add(hash);
		}
	}
	if (normalized.size === 0) {
		return new Set();
	}

	const url = new URL(`${TORBOX_API_BASE}/torrents/checkcached`);
	url.searchParams.set("format", "object");

	const { status, body } = await fetchText(url.toString(), {
		service: TORBOX_SERVICE,
		method: "POST",
		headers: {
			authorization: `Bearer ${options.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ hashes: [...normalized] }),
		timeoutMs: options.timeoutMs,
	});

	const envelope = parseEnvelopeLenient(body, status);

	if (status !== 200 || !envelope || !envelope.success) {
		throwForFailure(envelope, status);
	}

	return parseCachedHashes(envelope.data);
}

/**
 * Extract the set of cached (lowercased) info hashes from a checkcached
 * `data` payload. Tolerates the documented `object` shape (a map keyed by
 * hash), the `list` shape (an array of `{ hash }` entries), `null` (no
 * cached hashes), and malformed/partial entries (skipped). An unexpected
 * data shape is treated as "no cached hashes" rather than failing, so
 * cache enrichment stays advisory.
 */
function parseCachedHashes(data: unknown): Set<string> {
	const cached = new Set<string>();
	if (data === null || data === undefined) {
		return cached;
	}
	if (isRecord(data)) {
		for (const key of Object.keys(data)) {
			if (INFO_HASH_PATTERN.test(key)) {
				cached.add(key.toLowerCase());
				continue;
			}
			const entry = data[key];
			if (isRecord(entry)) {
				const hash = asString(entry.hash);
				if (hash && INFO_HASH_PATTERN.test(hash)) {
					cached.add(hash.toLowerCase());
				}
			}
		}
		return cached;
	}
	if (Array.isArray(data)) {
		for (const entry of data) {
			if (isRecord(entry)) {
				const hash = asString(entry.hash);
				if (hash && INFO_HASH_PATTERN.test(hash)) {
					cached.add(hash.toLowerCase());
				}
			}
		}
	}
	return cached;
}

export interface RequestDownloadLinkOptions extends TorboxClientOptions {
	torrentId: number;
	/** Download a single file by id. */
	fileId?: number;
	/** Download a whole-torrent zip archive. Takes precedence per the docs. */
	zip?: boolean;
}

/**
 * Request a temporary CDN download link from TorBox.
 * GET /torrents/requestdl?token=…&torrent_id=…(&file_id=…|&zip_link=true)
 *
 * Verified behavior (official docs):
 * - Auth is the API key in the required `token` query parameter; the Bearer
 *   header is sent as well (collection-level auth).
 * - `zip_link` is "required if no file_id" and "takes precedence over
 *   file_id if both are given".
 * - `data` is a temporary CDN URL string (valid ~3 hours for starting a
 *   download). The documented permalink form (`redirect=true`) embeds the
 *   API key in the URL and is deliberately never used.
 *
 * Only https: URLs are accepted; anything else is a parse error. The URL is
 * never logged and never embedded in error messages.
 */
export async function requestDownloadLink(
	options: RequestDownloadLinkOptions,
): Promise<string> {
	const url = new URL(`${TORBOX_API_BASE}/torrents/requestdl`);
	url.searchParams.set("token", options.apiKey);
	url.searchParams.set("torrent_id", String(options.torrentId));
	if (options.zip === true || options.fileId === undefined) {
		url.searchParams.set("zip_link", "true");
	} else {
		url.searchParams.set("file_id", String(options.fileId));
	}

	const { status, body } = await fetchText(url.toString(), {
		service: TORBOX_SERVICE,
		headers: { authorization: `Bearer ${options.apiKey}` },
		timeoutMs: options.timeoutMs,
	});

	const envelope = parseEnvelopeLenient(body, status);

	if (status !== 200 || !envelope || !envelope.success) {
		throwForFailure(envelope, status);
	}

	const raw = asString(envelope.data);
	if (!raw) {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned an unexpected download link payload",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned a malformed download link",
		);
	}
	if (parsed.protocol !== "https:") {
		throw new UpstreamParseError(
			TORBOX_SERVICE,
			"returned a download link with a disallowed protocol",
		);
	}
	return raw;
}

/**
 * What to download for a ready torrent. A torrent with exactly one file
 * yields that file; anything else yields the whole-torrent zip archive
 * (TorBox's documented archive option), which never requires guessing at
 * individual files.
 */
export type DownloadTarget =
	| { kind: "file"; file: TorboxFile }
	| { kind: "zip" };

/**
 * Deterministic download-target rule:
 * - exactly one downloadable file -> that file;
 * - zero or multiple files -> the whole-torrent zip archive.
 */
export function selectDownloadTarget(torrent: TorboxTorrent): DownloadTarget {
	if (torrent.files.length === 1) {
		return { kind: "file", file: torrent.files[0] };
	}
	return { kind: "zip" };
}

/** Result of the bounded readiness poll. */
export type TorrentReadiness =
	| { status: "ready"; torrent: TorboxTorrent }
	| { status: "processing"; torrent: TorboxTorrent | null }
	| { status: "not-found" };

export interface PollOptions {
	/** Delay between polls in milliseconds. */
	intervalMs: number;
	/** Hard cap on the number of polls (>= 1). */
	maxAttempts: number;
	/** Injectable delay (tests); defaults to setTimeout-based sleep. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a torrent until it is ready, the attempt budget is exhausted, or the
 * torrent disappears. Fully bounded: at most `maxAttempts` upstream calls,
 * each with its own upstream timeout, with `intervalMs` between attempts.
 *
 * Readiness rule: `download_finished === true`. The docs explicitly say
 * `download_state: "completed"` must not be used for completion status.
 *
 * A torrent that was seen before and then vanishes terminates as
 * "not-found"; one that was never seen yet (creation propagation) keeps
 * polling within the budget. Upstream errors (timeout, API, parse, network)
 * propagate to the caller and stop polling immediately.
 */
export async function waitForTorrentReady(
	id: number,
	options: TorboxClientOptions,
	poll: PollOptions,
): Promise<TorrentReadiness> {
	const sleep = poll.sleep ?? defaultSleep;
	const maxAttempts = Math.max(1, Math.floor(poll.maxAttempts));
	let seen = false;
	let lastTorrent: TorboxTorrent | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const torrent = await getTorrentById(id, options);
		if (torrent === null) {
			if (seen) {
				return { status: "not-found" };
			}
		} else {
			seen = true;
			lastTorrent = torrent;
			if (torrent.download_finished) {
				return { status: "ready", torrent };
			}
		}
		if (attempt < maxAttempts) {
			await sleep(poll.intervalMs);
		}
	}
	return { status: "processing", torrent: lastTorrent };
}
