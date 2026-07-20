import type { TorrentResult } from "../types/search";
import {
	ConfigError,
	UpstreamParseError,
	UpstreamStatusError,
} from "../utils/errors";
import { fetchText } from "../utils/http";

/**
 * Typed adapter for a user-controlled Prowlarr instance's search API.
 *
 * Verified against the official Prowlarr source (develop branch) and a
 * live Prowlarr instance (2026-07-19):
 * - `GET /api/v1/search` with query params `query`, `type` (default
 *   "search"), `indexerIds`, `categories`, `limit`, `offset`
 *   (src/Prowlarr.Api.V1/Search/SearchController.cs + SearchResource.cs).
 * - Authentication via the `X-Api-Key` header (or `apikey` query param)
 *   (src/Prowlarr.Http/Authentication/AuthenticationBuilderExtensions.cs).
 * - Unauthenticated requests return 401; the live instance confirms this.
 * - The response is a JSON array of releases with camelCase fields
 *   (src/Prowlarr.Api.V1/Search/ReleaseResource.cs): `title`, `size`,
 *   `indexer`, `categories` (`{id, name}` objects), `infoUrl`, `magnetUrl`,
 *   `infoHash`, `seeders`, `leechers`, `publishDate`, ...
 *
 * Security rules:
 * - The API key travels only in the `X-Api-Key` header; it is never logged
 *   and never embedded in the request URL.
 * - Prowlarr rewrites `downloadUrl`/`magnetUrl` in search responses into
 *   proxy URLs that EMBED THE API KEY (`/{indexerId}/download?apikey=...`,
 *   see SearchController.MapReleases + DownloadMappingService). Those fields
 *   are therefore never propagated, logged, or displayed: a normalized
 *   result's `magnetUri` only accepts a raw `magnet:` URI or is synthesized
 *   from the info hash, and `link` comes from the (un-proxied) `infoUrl`.
 * - Error types never carry request URLs or response payloads.
 */

const PROWLARR_SERVICE = "prowlarr" as const;
/** Never process more than this many releases from one response. */
const MAX_PARSED_RELEASES = 100;
/** Default and maximum number of results a caller may request. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface ProwlarrSearchOptions {
	apiKey: string;
	/** Origin of the Prowlarr instance, e.g. https://prowlarr.example.com */
	baseUrl: string;
	timeoutMs?: number;
	/** Maximum results to request and return (clamped to 1-100). */
	limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		Number.isSafeInteger(value)
		? value
		: undefined;
}

/** First Newznab category id from Prowlarr's `categories` array, if any. */
function firstCategoryId(value: unknown): number | null {
	if (!Array.isArray(value)) {
		return null;
	}
	for (const entry of value) {
		// Documented shape: IndexerCategory objects ({id, name, ...}).
		// Bare numeric ids are tolerated as a fallback.
		const id = isRecord(entry)
			? asNonNegativeInt(entry.id)
			: asNonNegativeInt(entry);
		if (id !== undefined) {
			return id;
		}
	}
	return null;
}

/**
 * Normalize one untrusted Prowlarr release into a TorrentResult.
 * Returns null for entries without a usable title. All other fields are
 * optional and degrade to null.
 */
function normalizeRelease(value: unknown): TorrentResult | null {
	if (!isRecord(value)) {
		return null;
	}
	const title = asString(value.title)?.trim();
	if (!title) {
		return null;
	}

	const seeders = asNonNegativeInt(value.seeders) ?? null;
	const leechers = asNonNegativeInt(value.leechers) ?? null;
	const infoHash = asString(value.infoHash) ?? null;

	// Prowlarr's `magnetUrl` is normally a proxy URL embedding the API key;
	// only a raw magnet: URI is safe to propagate. Otherwise synthesize a
	// bare info-hash magnet (a valid magnet URI accepted by TorBox).
	const upstreamMagnet = asString(value.magnetUrl);
	const magnetUri = upstreamMagnet?.startsWith("magnet:")
		? upstreamMagnet
		: infoHash
			? `magnet:?xt=urn:btih:${infoHash}`
			: null;

	return {
		title,
		sizeBytes: asNonNegativeInt(value.size) ?? null,
		seeders,
		// Prowlarr reports seeders and leechers separately; the normalized
		// model keeps the total swarm size (torznab "peers" semantics).
		peers:
			seeders !== null && leechers !== null ? seeders + leechers : null,
		categoryId: firstCategoryId(value.categories),
		source: asString(value.indexer) ?? null,
		// infoUrl is the indexer's details page and is never proxied.
		// downloadUrl is deliberately ignored (credential-bearing proxy URL).
		link: asString(value.infoUrl) ?? null,
		infoHash,
		magnetUri,
		publishedAt: asString(value.publishDate) ?? null,
	};
}

/**
 * Deterministic result ordering: seeders (desc), then size (desc), then
 * title (asc). Unknown values sort last.
 */
export function sortResults(results: readonly TorrentResult[]): TorrentResult[] {
	return results
		.map((result, index) => ({ result, index }))
		.sort((a, b) => {
			const seeders = (b.result.seeders ?? -1) - (a.result.seeders ?? -1);
			if (seeders !== 0) return seeders;
			const size = (b.result.sizeBytes ?? -1) - (a.result.sizeBytes ?? -1);
			if (size !== 0) return size;
			const title = a.result.title.localeCompare(b.result.title);
			if (title !== 0) return title;
			return a.index - b.index;
		})
		.map(({ result }) => result);
}

/**
 * Search Prowlarr for releases matching `query`. Results are sorted
 * deterministically and capped to the requested limit.
 *
 * Throws ConfigError, UpstreamTimeoutError, UpstreamNetworkError,
 * UpstreamStatusError, or UpstreamParseError. Error messages never contain
 * the API key, request URLs, or response payloads.
 */
export async function searchProwlarr(
	query: string,
	options: ProwlarrSearchOptions,
): Promise<TorrentResult[]> {
	const limit = Math.min(
		Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1),
		MAX_LIMIT,
	);

	let url: URL;
	try {
		url = new URL("/api/v1/search", options.baseUrl);
	} catch {
		throw new ConfigError("PROWLARR_URL is not a valid URL");
	}
	url.searchParams.set("query", query);
	url.searchParams.set("type", "search");
	url.searchParams.set("limit", String(limit));

	const { status, body } = await fetchText(url.toString(), {
		service: PROWLARR_SERVICE,
		timeoutMs: options.timeoutMs,
		headers: {
			accept: "application/json",
			"x-api-key": options.apiKey,
		},
	});

	if (status !== 200) {
		throw new UpstreamStatusError(PROWLARR_SERVICE, status);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new UpstreamParseError(PROWLARR_SERVICE, "returned invalid JSON");
	}

	if (!Array.isArray(parsed)) {
		throw new UpstreamParseError(
			PROWLARR_SERVICE,
			"returned an unexpected JSON structure",
		);
	}

	const results: TorrentResult[] = [];
	for (const entry of parsed.slice(0, MAX_PARSED_RELEASES)) {
		const result = normalizeRelease(entry);
		if (result) {
			results.push(result);
		}
	}

	return sortResults(results).slice(0, limit);
}
