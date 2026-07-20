import type {
	TorboxCreateTorrentData,
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
 * - The API key travels only in the Authorization header; it is never
 *   logged and never embedded in URLs (error types never carry URLs).
 * - Full magnet URIs are accepted as input but never logged or echoed.
 */

export const TORBOX_API_BASE = "https://api.torbox.app/v1/api";
const TORBOX_SERVICE = "torbox" as const;

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

	let envelope: TorboxResponse<unknown> | null = null;
	try {
		envelope = parseEnvelope(body);
	} catch (error) {
		if (status === 200) {
			throw error;
		}
		// Non-200 with a non-JSON body: fall through to a status error.
	}

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
		cached: value.cached === true,
	};
}

/**
 * List the account's torrents.
 * GET /torrents/mylist (optional id/offset/limit).
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

	const { status, body } = await fetchText(url.toString(), {
		service: TORBOX_SERVICE,
		headers: { authorization: `Bearer ${options.apiKey}` },
		timeoutMs: options.timeoutMs,
	});

	let envelope: TorboxResponse<unknown> | null = null;
	try {
		envelope = parseEnvelope(body);
	} catch (error) {
		if (status === 200) {
			throw error;
		}
	}

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
