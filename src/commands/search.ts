import { authorizeGuild, guildAuthMessage, type AppConfig } from "../config";
import { editOriginalResponse } from "../discord/client";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import {
	getStringOption,
	getInvokerId,
	type DiscordInteraction,
} from "../discord/types";
import { searchProwlarr } from "../services/prowlarr";
import { checkTorrentCache } from "../services/torbox";
import type { TorrentResult } from "../types/search";
import {
	formatBytes,
	sanitizeInline,
	truncate,
} from "../utils/format";
import { logUpstreamFailure, upstreamErrorMessage } from "./shared";
import { buildSearchComponents } from "./component";
import {
	isValidInfoHash,
	SELECT_OPTION_CAP,
} from "../utils/signing";

export const SEARCH_COMMAND_NAME = "search";
export const MAX_SEARCH_RESULTS = 5;
const MAX_QUERY_LENGTH = 200;
/** Discord select-option description hard limit. */
const DESCRIPTION_LIMIT = 100;
/** Cache badge appended to a cached result's option description. */
const CACHE_BADGE = "⚡ Cached";

/**
 * Validate the required `query` option. Returns null when missing, empty,
 * or over the length cap.
 */
export function extractSearchQuery(
	interaction: DiscordInteraction,
): string | null {
	const raw = getStringOption(interaction, "query")?.trim();
	if (!raw || raw.length > MAX_QUERY_LENGTH) {
		return null;
	}
	return raw;
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
 * - skipped entirely when TorBox is not configured or no selectable
 *   result carries a valid info hash (no request is made);
 * - on any failure (HTTP, auth, parse, network) logs a concise sanitized
 *   warning and leaves results unchanged, so `/search` still returns the
 *   Prowlarr results without cache badges.
 *
 * The selectable set mirrors the select menu (valid-hash results, capped
 * to SELECT_OPTION_CAP) so at most one cache request is made for up to
 * five results. Hashes are matched case-insensitively. No torrent is
 * submitted to TorBox and the account is never mutated.
 */
async function enrichWithCacheStatus(
	results: TorrentResult[],
	config: AppConfig,
): Promise<void> {
	if (!config.torboxApiKey) {
		return;
	}
	const selectableHashes: string[] = [];
	for (const result of results) {
		if (result.infoHash && isValidInfoHash(result.infoHash)) {
			selectableHashes.push(result.infoHash);
		}
		if (selectableHashes.length >= SELECT_OPTION_CAP) {
			break;
		}
	}
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
	for (const result of results) {
		if (result.infoHash && isValidInfoHash(result.infoHash)) {
			if (cached.has(result.infoHash.toLowerCase())) {
				result.isCached = true;
			}
		}
	}
}

async function completeSearch(
	interaction: DiscordInteraction,
	query: string,
	config: AppConfig,
): Promise<void> {
	// URL/key presence is checked by handleSearchCommand before deferring.
	const apiKey = config.prowlarrApiKey as string;
	const baseUrl = config.prowlarrUrl as string;

	let content: string;
	let components: object[] | null = null;

	try {
		const results = await searchProwlarr(query, {
			apiKey,
			baseUrl,
			timeoutMs: config.upstreamTimeoutMs,
			limit: MAX_SEARCH_RESULTS,
		});
		content = formatSearchResults(query, results);

		// Best-effort TorBox cache enrichment of the selectable results
		// (one batch request). Any failure logs a sanitized warning and
		// leaves results unchanged (no badges); /search still succeeds.
		await enrichWithCacheStatus(results, config);

		// Build select menu if signing is configured and there are selectable results.
		if (config.componentSigningSecret) {
			const userId = getInvokerId(interaction);
			if (userId) {
				components = await buildSearchComponents(
					results,
					userId,
					config.componentSigningSecret,
				);
			}
		}
	} catch (error) {
		logUpstreamFailure("search failed", error);
		content = upstreamErrorMessage(error);
	}

	try {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content, components: components ?? undefined },
		);
	} catch (error) {
		logUpstreamFailure("failed to edit interaction response", error);
	}
}

/**
 * Handle `/search query:<string>`. Defers immediately (Discord's initial
 * response deadline is 3 seconds) and completes the search in the
 * background, editing the original response with the results.
 */
export function handleSearchCommand(
	interaction: DiscordInteraction,
	config: AppConfig,
	ctx: ExecutionContext,
): Response {
	const query = extractSearchQuery(interaction);
	if (query === null) {
		return messageResponse(
			"Missing or invalid `query` option. Usage: `/search query:<text>` (1-200 characters).",
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

	ctx.waitUntil(completeSearch(interaction, query, config));
	return deferredMessageResponse();
}
