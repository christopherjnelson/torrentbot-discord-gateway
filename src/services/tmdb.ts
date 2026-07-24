import type {
	MediaSearchResult,
	MediaDetails,
	MediaType,
	TvDetails,
	TvSeasonSummary,
} from "../types/media";
import {
	ConfigError,
	UpstreamParseError,
	UpstreamStatusError,
	UserInputError,
} from "../utils/errors";
import { fetchText } from "../utils/http";

/**
 * Minimal TMDB v3 adapter.
 *
 * Official contracts verified 2026-07-24:
 * - GET /3/search/movie
 * - GET /3/search/tv
 * - GET /3/movie/{movie_id}
 * - GET /3/tv/{series_id}
 * - application authentication via Authorization: Bearer <read token>
 *
 * Only the fields represented by MediaSearchResult and TvSeasonSummary are
 * read. Raw payloads, URLs, and authorization headers are never logged or
 * placed in errors.
 */

const TMDB_SERVICE = "tmdb" as const;
const TMDB_API_BASE = "https://api.themoviedb.org/3/";
export const TMDB_SEARCH_RESULT_CAP = 10;
const TMDB_MAX_PARSED_RESULTS = 50;
const TMDB_MAX_QUERY_LENGTH = 200;
const TMDB_MAX_TITLE_LENGTH = 200;
const TMDB_MAX_OVERVIEW_LENGTH = 1_000;
const TMDB_MAX_GENRES = 5;
const TMDB_MAX_GENRE_LENGTH = 50;
const TMDB_MAX_STATUS_LENGTH = 80;
const POSTER_PATH_PATTERN = /^\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i;

export interface TmdbOptions {
	readAccessToken: string;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuery(query: string): string {
	const normalized = query.trim();
	if (
		normalized.length === 0 ||
		normalized.length > TMDB_MAX_QUERY_LENGTH
	) {
		throw new UserInputError("TMDB query must be 1-200 characters");
	}
	return normalized;
}

function normalizeTitle(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	let cleaned = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		cleaned += code < 32 || code === 127 ? " " : character;
	}
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) {
		return null;
	}
	return Array.from(cleaned)
		.slice(0, TMDB_MAX_TITLE_LENGTH)
		.join("")
		.trim() || null;
}

function normalizeId(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0
		? value
		: null;
}

function normalizePopularity(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0
		? value
		: null;
}

function normalizeNonNegativeInt(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: null;
}

function normalizePositiveInt(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0
		? value
		: null;
}

function normalizeBoundedText(value: unknown, limit: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	let cleaned = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		cleaned += code < 32 || code === 127 ? " " : character;
	}
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	return cleaned
		? Array.from(cleaned).slice(0, limit).join("").trim() || null
		: null;
}

function normalizePosterPath(value: unknown): string | null {
	return typeof value === "string" && POSTER_PATH_PATTERN.test(value)
		? value
		: null;
}

function normalizeGenres(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const genres: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry)) {
			continue;
		}
		const name = normalizeBoundedText(entry.name, TMDB_MAX_GENRE_LENGTH);
		const key = name?.toLocaleLowerCase();
		if (!name || !key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		genres.push(name);
		if (genres.length >= TMDB_MAX_GENRES) {
			break;
		}
	}
	return genres;
}

function normalizeEpisodeRuntime(value: unknown): number | null {
	if (!Array.isArray(value)) {
		return null;
	}
	for (const entry of value) {
		const runtime = normalizePositiveInt(entry);
		if (runtime !== null) {
			return runtime;
		}
	}
	return null;
}

function normalizeDetails(
	value: unknown,
	mediaType: MediaType,
): MediaDetails | null {
	const media = normalizeMedia(value, mediaType);
	if (!media || !isRecord(value)) {
		return null;
	}
	return {
		...media,
		overview: normalizeBoundedText(value.overview, TMDB_MAX_OVERVIEW_LENGTH),
		posterPath: normalizePosterPath(value.poster_path),
		genres: normalizeGenres(value.genres),
		runtimeMinutes:
			mediaType === "movie" ? normalizePositiveInt(value.runtime) : null,
		episodeRunTimeMinutes:
			mediaType === "tv"
				? normalizeEpisodeRuntime(value.episode_run_time)
				: null,
		status: normalizeBoundedText(value.status, TMDB_MAX_STATUS_LENGTH),
	};
}

function normalizeYear(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1000 || year > 9999) {
		return null;
	}
	const timestamp = Date.UTC(year, month - 1, day);
	const parsed = new Date(timestamp);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month - 1 ||
		parsed.getUTCDate() !== day
	) {
		return null;
	}
	return year;
}

function normalizeMedia(
	value: unknown,
	mediaType: MediaType,
): MediaSearchResult | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = normalizeId(value.id);
	const title = normalizeTitle(
		mediaType === "movie" ? value.title : value.name,
	);
	if (id === null || title === null) {
		return null;
	}
	return {
		id,
		mediaType,
		title,
		originalTitle: normalizeTitle(
			mediaType === "movie" ? value.original_title : value.original_name,
		),
		year: normalizeYear(
			mediaType === "movie" ? value.release_date : value.first_air_date,
		),
		popularity: normalizePopularity(value.popularity),
	};
}

/**
 * Normalize the season summaries embedded in a TV-details response.
 * Malformed rows are skipped, the first valid occurrence of a season number
 * wins, and the result is sorted numerically so Specials (season 0) is first.
 */
export function normalizeTvSeasons(value: unknown): TvSeasonSummary[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<number>();
	const seasons: TvSeasonSummary[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) {
			continue;
		}
		const seasonNumber = normalizeNonNegativeInt(entry.season_number);
		if (seasonNumber === null || seen.has(seasonNumber)) {
			continue;
		}
		seen.add(seasonNumber);
		seasons.push({
			seasonNumber,
			episodeCount: normalizeNonNegativeInt(entry.episode_count),
		});
	}
	return seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
}

function buildUrl(path: string): URL {
	const url = new URL(path, TMDB_API_BASE);
	if (url.protocol !== "https:" || url.origin !== "https://api.themoviedb.org") {
		throw new ConfigError("TMDB API endpoint is invalid");
	}
	return url;
}

async function requestJson(
	url: URL,
	options: TmdbOptions,
): Promise<unknown> {
	if (!options.readAccessToken.trim()) {
		throw new ConfigError("TMDB read access token is not configured");
	}
	const { status, body } = await fetchText(url.toString(), {
		service: TMDB_SERVICE,
		timeoutMs: options.timeoutMs,
		headers: {
			accept: "application/json",
			authorization: `Bearer ${options.readAccessToken}`,
		},
	});
	if (status !== 200) {
		throw new UpstreamStatusError(TMDB_SERVICE, status);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new UpstreamParseError(TMDB_SERVICE, "returned invalid JSON");
	}
}

/** Search movies or TV series, preserving upstream order and deduplicating IDs. */
export async function searchTmdb(
	mediaType: MediaType,
	query: string,
	options: TmdbOptions,
): Promise<MediaSearchResult[]> {
	const url = buildUrl(mediaType === "movie" ? "search/movie" : "search/tv");
	url.searchParams.set("query", normalizeQuery(query));
	url.searchParams.set("include_adult", "false");
	url.searchParams.set("page", "1");

	const parsed = await requestJson(url, options);
	if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
		throw new UpstreamParseError(
			TMDB_SERVICE,
			"returned an unexpected JSON structure",
		);
	}

	const seen = new Set<number>();
	const results: MediaSearchResult[] = [];
	for (const entry of parsed.results.slice(0, TMDB_MAX_PARSED_RESULTS)) {
		const normalized = normalizeMedia(entry, mediaType);
		if (!normalized || seen.has(normalized.id)) {
			continue;
		}
		seen.add(normalized.id);
		results.push(normalized);
		if (results.length >= TMDB_SEARCH_RESULT_CAP) {
			break;
		}
	}
	return results;
}

/** Fetch trusted canonical metadata for a selected numeric TMDB ID. */
export function getTmdbDetails(
	mediaType: "movie",
	id: number,
	options: TmdbOptions,
): Promise<MediaDetails>;
export function getTmdbDetails(
	mediaType: "tv",
	id: number,
	options: TmdbOptions,
): Promise<TvDetails>;
export async function getTmdbDetails(
	mediaType: MediaType,
	id: number,
	options: TmdbOptions,
): Promise<MediaDetails | TvDetails> {
	if (!Number.isSafeInteger(id) || id <= 0) {
		throw new UserInputError("Invalid TMDB media ID");
	}
	const url = buildUrl(`${mediaType}/${id}`);
	const parsed = await requestJson(url, options);
	const normalized = normalizeDetails(parsed, mediaType);
	if (!normalized || normalized.id !== id) {
		throw new UpstreamParseError(
			TMDB_SERVICE,
			"returned an unexpected details structure",
		);
	}
	return mediaType === "tv"
		? {
				...normalized,
				mediaType: "tv",
				seasons: normalizeTvSeasons(
					isRecord(parsed) ? parsed.seasons : undefined,
				),
			}
		: normalized;
}
