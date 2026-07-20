import type { AppConfig } from "../config";
import { editOriginalResponse } from "../discord/client";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import {
	getStringOption,
	type DiscordInteraction,
} from "../discord/types";
import { searchTorrents, sortResults } from "../services/voyager";
import type { TorrentResult } from "../types/torznab";
import {
	TorznabResponseError,
	UpstreamNetworkError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";
import {
	categoryName,
	DISCORD_CONTENT_LIMIT,
	formatBytes,
	sanitizeInline,
	truncate,
} from "../utils/format";

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

function formatResultLine(result: TorrentResult, index: number): string {
	const parts: string[] = [formatBytes(result.sizeBytes)];

	if (result.seeders !== null) {
		parts.push(`${result.seeders} seeds`);
	}
	const category = categoryName(result.categoryId);
	if (category) {
		parts.push(category);
	}
	if (result.source) {
		parts.push(sanitizeInline(result.source, 30));
	}
	if (result.magnetUri) {
		parts.push("magnet ✓");
	} else if (result.infoHash) {
		parts.push("hash ✓");
	}

	const title = sanitizeInline(result.title, 120);
	return `**${index + 1}.** \`${title}\` — ${parts.join(" · ")}`;
}

/**
 * Build the Discord message for a set of results. Guaranteed to fit within
 * Discord's 2000-character content limit. Magnet URIs and info hashes are
 * never included — availability markers only.
 */
export function formatSearchResults(
	query: string,
	results: readonly TorrentResult[],
): string {
	const safeQuery = sanitizeInline(query, 80);

	if (results.length === 0) {
		return `No results found for \`${safeQuery}\`.`;
	}

	const shown = results.slice(0, MAX_SEARCH_RESULTS);
	const lines = [
		`**Top ${shown.length} result${shown.length === 1 ? "" : "s"} for** \`${safeQuery}\`:`,
		...shown.map(formatResultLine),
	];
	if (results.length > shown.length) {
		lines.push(`_Showing ${shown.length} of ${results.length} results._`);
	}

	return truncate(lines.join("\n"), DISCORD_CONTENT_LIMIT);
}

/** Map internal errors to safe, user-facing Discord messages. */
export function searchErrorMessage(error: unknown): string {
	if (error instanceof UpstreamTimeoutError) {
		return "Search timed out. The search service is slow right now — try again in a moment.";
	}
	if (error instanceof UpstreamStatusError) {
		if (error.status === 429) {
			return "The search service is rate limiting us right now. Try again in a minute.";
		}
		return `The search service returned an error (HTTP ${error.status}). Try again later.`;
	}
	if (error instanceof TorznabResponseError) {
		return `The search service could not complete the search: ${error.message}`;
	}
	if (error instanceof UpstreamParseError) {
		return "The search service returned an unexpected response. Please try again later.";
	}
	if (error instanceof UpstreamNetworkError) {
		return "Could not reach the search service. Please try again later.";
	}
	return "Something went wrong while searching. Please try again later.";
}

async function completeSearch(
	interaction: DiscordInteraction,
	query: string,
	config: AppConfig,
): Promise<void> {
	// apiKey presence is checked by handleSearchCommand before deferring.
	const apiKey = config.voyagerApiKey as string;

	let content: string;
	try {
		const results = sortResults(
			await searchTorrents(query, {
				apiKey,
				timeoutMs: config.upstreamTimeoutMs,
			}),
		);
		content = formatSearchResults(query, results);
	} catch (error) {
		// Log classification only; upstream errors never contain secrets/URLs.
		console.warn(
			`search failed: ${error instanceof Error ? error.name : "unknown"}`,
		);
		content = searchErrorMessage(error);
	}

	try {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content },
		);
	} catch (error) {
		console.warn(
			`failed to edit interaction response: ${
				error instanceof Error ? error.name : "unknown"
			}`,
		);
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

	if (!config.voyagerApiKey) {
		return messageResponse(
			"Search is not configured on this bot. The owner needs to set a Voyager/TorBox API key.",
			true,
		);
	}

	ctx.waitUntil(completeSearch(interaction, query, config));
	return deferredMessageResponse();
}
