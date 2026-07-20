import type { AppConfig } from "../config";
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
import type { TorrentResult } from "../types/search";
import {
	formatBytes,
	sanitizeInline,
} from "../utils/format";
import { logUpstreamFailure, upstreamErrorMessage } from "./shared";
import { buildSearchComponents } from "./component";

export const SEARCH_COMMAND_NAME = "search";
export const MAX_SEARCH_RESULTS = 5;
const MAX_QUERY_LENGTH = 200;

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
 * Missing metadata is omitted (never replaced with a placeholder).
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

	return parts.join(" • ");
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

	if (!config.prowlarrUrl || !config.prowlarrApiKey) {
		return messageResponse(
			"Search is not configured on this bot. The owner needs to set the Prowlarr URL and API key.",
			true,
		);
	}

	ctx.waitUntil(completeSearch(interaction, query, config));
	return deferredMessageResponse();
}
