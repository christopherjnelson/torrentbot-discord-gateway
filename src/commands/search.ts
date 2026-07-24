import { authorizeGuild, guildAuthMessage, type AppConfig } from "../config";
import { editOriginalResponse } from "../discord/client";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import {
	getInvokerId,
	APPLICATION_COMMAND_OPTION_STRING,
	APPLICATION_COMMAND_OPTION_SUBCOMMAND,
	type ApplicationCommandData,
	type DiscordInteraction,
} from "../discord/types";
import { searchProwlarr } from "../services/prowlarr";
import { searchTmdb } from "../services/tmdb";
import { checkTorrentCache } from "../services/torbox";
import type { TorrentResult } from "../types/search";
import {
	formatBytes,
	sanitizeInline,
	truncate,
} from "../utils/format";
import {
	logDiscordApiFailure,
	logUpstreamFailure,
	upstreamErrorMessage,
} from "./shared";
import { buildSearchComponents } from "./component";
import {
	isValidInfoHash,
	SELECT_OPTION_CAP,
} from "../utils/signing";
import { buildSelectableOptions } from "../utils/selectable";
import { buildMediaComponents, formatMediaHeading } from "./media";
import type { MediaType } from "../types/media";
import {
	errorEmbed,
	queryFooter,
	queryFromFooter,
	releaseSelectionEmbed,
	validateMessagePayload,
	type DiscordMessagePayload,
} from "../discord/presentation";
import {
	createWorkflowPayload,
	digestComponentQuery,
	type WorkflowComponentPayload,
} from "../utils/signing";

export const SEARCH_COMMAND_NAME = "search";
export const MAX_SEARCH_RESULTS = 10;
/**
 * Number of releases to request from Prowlarr. Higher than the selectable
 * cap (MAX_SEARCH_RESULTS) to provide headroom for duplicate hashes,
 * invalid hashes, and empty labels, so `buildSelectableOptions` can still
 * fill the cap. The Prowlarr service clamps this to 1–100.
 */
const PROWLARR_REQUEST_LIMIT = 25;
export const MAX_QUERY_LENGTH = 200;
/** Discord select-option description hard limit. */
const DESCRIPTION_LIMIT = 100;
/** Cache badge appended to a cached result's option description. */
const CACHE_BADGE = "⚡ Cached";

/**
 * Strictly parse Discord's nested `/search <subcommand> query:<text>` shape.
 * Missing, unknown, malformed, duplicated, and legacy flat options all fail.
 */
export type SearchKind = "general" | "movie" | "tv";

export interface SearchRoute {
	kind: SearchKind;
	query: string;
}

export function extractSearchRoute(
	interaction: DiscordInteraction,
): SearchRoute | null {
	const data = interaction.data as ApplicationCommandData | undefined;
	if (!data?.options || data.options.length !== 1) {
		return null;
	}
	const subcommand = data.options[0];
	if (
		subcommand.type !== APPLICATION_COMMAND_OPTION_SUBCOMMAND ||
		subcommand.value !== undefined ||
		!isSearchKind(subcommand.name) ||
		!subcommand.options ||
		subcommand.options.length !== 1
	) {
		return null;
	}
	const queryOption = subcommand.options[0];
	if (
		queryOption.name !== "query" ||
		queryOption.type !== APPLICATION_COMMAND_OPTION_STRING ||
		typeof queryOption.value !== "string" ||
		queryOption.options !== undefined
	) {
		return null;
	}
	const raw = queryOption.value.trim();
	if (!raw || raw.length > MAX_QUERY_LENGTH) {
		return null;
	}
	return { kind: subcommand.name, query: raw };
}

function isSearchKind(value: string): value is SearchKind {
	return value === "general" || value === "movie" || value === "tv";
}

/**
 * Build the concise option description for a search result:
 *   <size> • <n> seeds • <source>
 * Missing metadata is omitted (never replaced with a placeholder). When
 * TorBox reports the result's hash as cached, a `⚡ Cached` badge is
 * appended. The final description is truncated to the Discord select
 * option limit of 100 characters; the badge alone is a valid description.
 */
export function formatResultDescription(result: TorrentResult): string {
	const parts: string[] = [];

	const size = formatBytes(result.sizeBytes);
	if (result.sizeBytes !== null && result.sizeBytes >= 0) {
		parts.push(size);
	}
	if (result.seeders !== null) {
		parts.push(`${result.seeders} seeds`);
	}
	if (result.source) {
		parts.push(sanitizeInline(result.source, 30));
	}

	let description = parts.join(" • ");
	if (result.isCached) {
		description =
			description.length > 0 ? `${description} • ${CACHE_BADGE}` : CACHE_BADGE;
	}
	return truncate(description, DESCRIPTION_LIMIT);
}

/**
 * Build the concise Discord message for a set of results: a single heading
 * with the search query and no duplicated numbered list. The select menu
 * (built separately) carries the actual result rows.
 */
export function formatSearchResults(
	query: string,
	results: readonly TorrentResult[],
): string {
	const safeQuery = sanitizeInline(query, 80);

	if (results.length === 0) {
		return `No results found for \`${safeQuery}\`.`;
	}

	return `Choose a release for **${safeQuery}**:`;
}

/**
 * Annotate the selectable search results with TorBox cache status using a
 * single batch cache-check request. Best-effort and advisory only:
 * - skipped entirely when TorBox is not configured or the selectable set
 *   is empty (no request is made);
 * - on any failure (HTTP, auth, parse, network) logs a concise sanitized
 *   warning and leaves results unchanged, so `/search` still returns the
 *   Prowlarr results without cache badges.
 *
 * The caller passes the exact selectable set that will be rendered in the
 * select menu (valid-hash, deduplicated, label-filtered, capped to
 * SELECT_OPTION_CAP), so the cache check, annotation, and menu all
 * operate on the same results. Hashes are matched case-insensitively. No
 * torrent is submitted to TorBox and the account is never mutated.
 */
async function enrichWithCacheStatus(
	selectable: TorrentResult[],
	config: AppConfig,
): Promise<void> {
	if (!config.torboxApiKey || selectable.length === 0) {
		return;
	}
	const selectableHashes = selectable
		.map((r) => r.infoHash)
		.filter((h): h is string => typeof h === "string" && isValidInfoHash(h));
	if (selectableHashes.length === 0) {
		return;
	}

	let cached: Set<string>;
	try {
		cached = await checkTorrentCache(selectableHashes, {
			apiKey: config.torboxApiKey,
			timeoutMs: config.upstreamTimeoutMs,
		});
	} catch (error) {
		logUpstreamFailure("torbox cache check failed", error);
		return;
	}

	if (cached.size === 0) {
		return;
	}
	for (const result of selectable) {
		if (result.infoHash && isValidInfoHash(result.infoHash)) {
			if (cached.has(result.infoHash.toLowerCase())) {
				result.isCached = true;
			}
		}
	}
}

export async function completeSearch(
	interaction: DiscordInteraction,
	query: string,
	config: AppConfig,
	workflowPayload?: WorkflowComponentPayload,
): Promise<void> {
	// URL/key presence is checked by handleSearchCommand before deferring.
	const apiKey = config.prowlarrApiKey as string;
	const baseUrl = config.prowlarrUrl as string;

	let message: DiscordMessagePayload;
	let components: object[] | null = null;

	try {
		const results = await searchProwlarr(query, {
			apiKey,
			baseUrl,
			timeoutMs: config.upstreamTimeoutMs,
			limit: PROWLARR_REQUEST_LIMIT,
		});
		// Single authoritative selectable sequence:
		// Prowlarr results -> valid hashes -> deduplicate by normalized
		// hash -> remove unusable labels -> continue scanning until ten
		// valid options. The cache check, annotation, and menu all use
		// this exact array.
		const selectable = buildSelectableOptions(results, SELECT_OPTION_CAP);

		// Best-effort TorBox cache enrichment of the selectable results
		// (one batch request). Any failure logs a sanitized warning and
		// leaves results unchanged (no badges); /search still succeeds.
		await enrichWithCacheStatus(selectable, config);

		// Build select menu if signing is configured and there are selectable results.
		if (config.componentSigningSecret) {
			const userId = getInvokerId(interaction);
			if (userId) {
				const payload =
					workflowPayload ??
					createWorkflowPayload({
						userId,
						action: "release",
						mediaType: "general",
						queryDigest: await digestComponentQuery(query),
					});
				components = await buildSearchComponents(
					selectable,
					{ ...payload, action: "release" },
					config.componentSigningSecret,
				);
			}
		}
		if (selectable.length === 0) {
			message = {
				content: formatSearchResults(query, []),
				embeds: [
					errorEmbed(
						"No releases found",
						"Try another season, use exact search, or refine the title.",
					),
				],
				components: [],
			};
		} else {
			const originalQuery =
				workflowPayload === undefined
					? query
					: queryFromWorkflowSource(interaction, query);
			message = {
				content: formatSearchResults(query, selectable),
				embeds: [
					releaseSelectionEmbed(
						releaseLabel(workflowPayload),
						query,
						selectable,
						originalQuery,
					),
				],
				components: components ?? [],
			};
		}
	} catch (error) {
		logUpstreamFailure("search failed", error);
		message = {
			content: upstreamErrorMessage(error),
			embeds: [errorEmbed("Search unavailable", upstreamErrorMessage(error))],
			components: [],
		};
	}

	try {
		validateMessagePayload(message);
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			message,
		);
	} catch (error) {
		logDiscordApiFailure("failed to edit interaction response", error);
	}
}

function queryFromWorkflowSource(
	interaction: DiscordInteraction,
	fallback: string,
): string {
	return queryFromFooter(interaction.message?.embeds) ?? fallback;
}

function releaseLabel(payload: WorkflowComponentPayload | undefined): string {
	if (!payload || payload.mediaType === "general") {
		return "General search";
	}
	if (payload.mediaType === "movie") {
		return "Movie releases";
	}
	if (payload.seasonNumber === 0) {
		return "TV series — Specials";
	}
	if (payload.seasonNumber === -1) {
		return "TV series — Complete series";
	}
	if (payload.seasonNumber !== null && payload.seasonNumber > 0) {
		return `TV series — Season ${payload.seasonNumber}`;
	}
	return "TV releases";
}

export async function completeMediaLookup(
	interaction: DiscordInteraction,
	mediaType: MediaType,
	query: string,
	config: AppConfig,
): Promise<void> {
	const startedAt = Date.now();
	let content: string;
	let components: object[] | undefined;
	let embeds: DiscordMessagePayload["embeds"];
	try {
		const results = await searchTmdb(mediaType, query, {
			readAccessToken: config.tmdbReadAccessToken as string,
			timeoutMs: config.upstreamTimeoutMs,
		});
		console.info(
			JSON.stringify({
				operation: "tmdb_search",
				mediaType,
				outcome: "success",
				elapsedMs: Date.now() - startedAt,
				queryLength: query.length,
				resultCount: results.length,
			}),
		);
		if (results.length === 0) {
			content =
				mediaType === "movie"
					? "No matching movies were found. Try `/search general` to search exactly as entered."
					: "No matching TV series were found. Try `/search general` to search exactly as entered.";
		} else {
			const userId = getInvokerId(interaction);
			if (!userId || !config.componentSigningSecret) {
				throw new Error("media component configuration unavailable");
			}
			content = formatMediaHeading(mediaType, query);
			components = await buildMediaComponents(
				results,
				mediaType,
				query,
				userId,
				config.componentSigningSecret,
			);
			embeds = [
				{
					title:
						mediaType === "movie"
							? "Choose a movie"
							: "Choose a TV series",
					description: `${results.length} matching result${
						results.length === 1 ? "" : "s"
					}. Select the best match below.`,
					color: 0x5865f2,
					footer: queryFooter(query),
				},
			];
		}
	} catch (error) {
		logUpstreamFailure("tmdb search failed", error);
		console.info(
			JSON.stringify({
				operation: "tmdb_search",
				mediaType,
				outcome: "failure",
				elapsedMs: Date.now() - startedAt,
				queryLength: query.length,
				errorCategory:
					error instanceof Error ? error.name : "unknown",
			}),
		);
		content =
			"The media lookup service is unavailable right now. Please try again.";
	}

	try {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content, embeds, components: components ?? [] },
		);
	} catch (error) {
		logDiscordApiFailure("failed to edit interaction response", error);
	}
}

/**
 * Handle `/search <general|movie|tv> query:<string>`. General defers
 * immediately (Discord's initial
 * response deadline is 3 seconds) and completes the search in the
 * background, editing the original response with the results.
 */
export function handleSearchCommand(
	interaction: DiscordInteraction,
	config: AppConfig,
	ctx: ExecutionContext,
): Response {
	const route = extractSearchRoute(interaction);
	if (route === null) {
		return messageResponse(
			"Invalid search options. Usage: `/search general|movie|tv query:<text>` (1-200 characters).",
			true,
		);
	}

	const authStatus = authorizeGuild(
		interaction.guild_id,
		config.torboxAllowedGuildIds,
	);
	if (authStatus !== "allowed") {
		return messageResponse(guildAuthMessage(authStatus), true);
	}

	if (!config.prowlarrUrl || !config.prowlarrApiKey) {
		return messageResponse(
			"Search is not configured on this bot. The owner needs to set the Prowlarr URL and API key.",
			true,
		);
	}

	if (
		route.kind !== "general" &&
		(!config.tmdbReadAccessToken || !config.componentSigningSecret)
	) {
		return messageResponse(
			"Movie and TV lookup is not configured on this bot.",
			true,
		);
	}

	ctx.waitUntil(
		route.kind === "general"
			? completeSearch(interaction, route.query, config)
			: completeMediaLookup(interaction, route.kind, route.query, config),
	);
	return deferredMessageResponse(true);
}
