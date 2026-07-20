import { getConfig, type AppConfig } from "../config";
import { progressPercent } from "../commands/status";
import { createTorrent, listTorrents } from "../services/torbox";
import { searchTorrents, sortResults } from "../services/voyager";
import type { TorrentResult } from "../types/torznab";
import type { TorboxTorrent } from "../types/torbox";
import { isValidBearer } from "../utils/auth";
import {
	TorznabResponseError,
	UpstreamApiError,
	UpstreamNetworkError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";
import { isValidMagnetUri } from "../utils/magnet";
import { sanitizeInline } from "../utils/format";

/**
 * Internal authenticated HTTP API for automation (e.g. n8n).
 *
 * Every route requires `Authorization: Bearer <INTERNAL_API_TOKEN>` and
 * returns a consistent JSON envelope: `{ ok: true, ... }` or
 * `{ ok: false, error }`. These routes share no semantics with the Discord
 * interaction handler — no deferrals, no follow-ups, plain request/response.
 */

const MAX_BODY_BYTES = 8192;
const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 5;

function ok(data: Record<string, unknown>, status = 200): Response {
	return Response.json({ ok: true, ...data }, { status });
}

function fail(error: string, status: number): Response {
	return Response.json({ ok: false, error }, { status });
}

/** Map upstream failures to safe JSON errors. Never leaks keys or URLs. */
function upstreamFailure(error: unknown): Response {
	if (error instanceof UpstreamTimeoutError) {
		return fail("Upstream service timed out", 504);
	}
	if (error instanceof UpstreamApiError) {
		return fail(
			sanitizeInline(error.message, 200),
			error.status === 429 ? 429 : 502,
		);
	}
	if (error instanceof UpstreamStatusError) {
		if (error.status === 429) {
			return fail("Upstream service rate limited the request", 429);
		}
		return fail(`Upstream service returned HTTP ${error.status}`, 502);
	}
	if (error instanceof TorznabResponseError) {
		return fail(sanitizeInline(error.message, 200), 502);
	}
	if (
		error instanceof UpstreamParseError ||
		error instanceof UpstreamNetworkError
	) {
		return fail("Upstream service communication failed", 502);
	}
	return fail("Internal error", 500);
}

async function readJsonBody(request: Request): Promise<unknown | null> {
	let text: string;
	try {
		text = await request.text();
	} catch {
		return null;
	}
	if (text.length > MAX_BODY_BYTES) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeResult(result: TorrentResult) {
	return {
		title: result.title,
		sizeBytes: result.sizeBytes,
		seeders: result.seeders,
		peers: result.peers,
		categoryId: result.categoryId,
		source: result.source,
		link: result.link,
		infoHash: result.infoHash,
		// The internal API is authenticated server-to-server traffic, so the
		// magnet URI is included for downstream automation (unlike Discord).
		magnetUri: result.magnetUri,
		publishedAt: result.publishedAt,
	};
}

function serializeTorrent(torrent: TorboxTorrent) {
	return {
		id: torrent.id,
		name: torrent.name,
		hash: torrent.hash,
		sizeBytes: torrent.size,
		state: torrent.download_state,
		progress: torrent.progress,
		progressPercent: progressPercent(torrent.progress),
		seeds: torrent.seeds,
		peers: torrent.peers,
		downloadSpeedBytes: torrent.download_speed,
		uploadSpeedBytes: torrent.upload_speed,
		cached: torrent.cached,
		downloadFinished: torrent.download_finished,
		createdAt: torrent.created_at,
		updatedAt: torrent.updated_at,
		// Deliberately excluded: download URLs, file lists, server paths.
	};
}

async function handleSearch(
	request: Request,
	config: AppConfig,
): Promise<Response> {
	const body = await readJsonBody(request);
	if (!isRecord(body)) {
		return fail("Invalid JSON body", 400);
	}
	const query = typeof body.query === "string" ? body.query.trim() : "";
	if (!query || query.length > MAX_QUERY_LENGTH) {
		return fail(`Field 'query' must be a string of 1-${MAX_QUERY_LENGTH} characters`, 400);
	}

	let limit = DEFAULT_SEARCH_LIMIT;
	if (body.limit !== undefined) {
		if (
			typeof body.limit !== "number" ||
			!Number.isInteger(body.limit) ||
			body.limit < 1 ||
			body.limit > MAX_SEARCH_LIMIT
		) {
			return fail(`Field 'limit' must be an integer of 1-${MAX_SEARCH_LIMIT}`, 400);
		}
		limit = body.limit;
	}

	if (!config.voyagerApiKey) {
		return fail("Search is not configured on this worker", 503);
	}

	try {
		const results = sortResults(
			await searchTorrents(query, {
				apiKey: config.voyagerApiKey,
				timeoutMs: config.upstreamTimeoutMs,
			}),
		);
		return ok({
			query,
			count: Math.min(results.length, limit),
			results: results.slice(0, limit).map(serializeResult),
		});
	} catch (error) {
		return upstreamFailure(error);
	}
}

async function handleCreateTorrent(
	request: Request,
	config: AppConfig,
): Promise<Response> {
	const body = await readJsonBody(request);
	if (!isRecord(body)) {
		return fail("Invalid JSON body", 400);
	}
	const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
	if (!magnet || !isValidMagnetUri(magnet)) {
		return fail("Field 'magnet' must be a valid magnet URI", 400);
	}

	if (!config.torboxApiKey) {
		return fail("TorBox is not configured on this worker", 503);
	}

	try {
		const created = await createTorrent(magnet, {
			apiKey: config.torboxApiKey,
			timeoutMs: config.upstreamTimeoutMs,
		});
		return ok(
			{
				torrentId: created.torrent_id,
				hash: created.hash,
			},
			201,
		);
	} catch (error) {
		if (error instanceof UpstreamApiError && error.code === "DUPLICATE_ITEM") {
			return fail("That download is already on the TorBox account", 409);
		}
		return upstreamFailure(error);
	}
}

async function handleGetTorrent(
	idParam: string,
	config: AppConfig,
): Promise<Response> {
	const id = Number.parseInt(idParam, 10);
	if (!Number.isInteger(id) || id < 0 || String(id) !== idParam) {
		return fail("Torrent id must be a non-negative integer", 400);
	}

	if (!config.torboxApiKey) {
		return fail("TorBox is not configured on this worker", 503);
	}

	try {
		const torrents = await listTorrents({
			apiKey: config.torboxApiKey,
			id,
			timeoutMs: config.upstreamTimeoutMs,
		});
		const torrent = torrents.find((candidate) => candidate.id === id);
		if (!torrent) {
			return fail("Torrent not found", 404);
		}
		return ok({ torrent: serializeTorrent(torrent) });
	} catch (error) {
		return upstreamFailure(error);
	}
}

/**
 * Route /api/* requests. Every route requires bearer authentication with
 * the INTERNAL_API_TOKEN secret (constant-time comparison).
 */
export async function handleApiRequest(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const config = getConfig(env);

	if (!config.internalApiToken) {
		return fail("Internal API is not configured on this worker", 503);
	}

	const authorized = await isValidBearer(
		request.headers.get("authorization"),
		config.internalApiToken,
	);
	if (!authorized) {
		return fail("Unauthorized", 401);
	}

	if (request.method === "POST" && url.pathname === "/api/search") {
		return handleSearch(request, config);
	}

	if (request.method === "POST" && url.pathname === "/api/torrents") {
		return handleCreateTorrent(request, config);
	}

	const torrentMatch = /^\/api\/torrents\/([^/]+)$/.exec(url.pathname);
	if (request.method === "GET" && torrentMatch) {
		return handleGetTorrent(torrentMatch[1], config);
	}

	return fail("Not found", 404);
}
