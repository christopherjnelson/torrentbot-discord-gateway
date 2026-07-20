import {
	DiscordApiError,
	editOriginalResponse,
} from "../discord/client";
import type { DiscordInteraction } from "../discord/types";
import {
	UpstreamApiError,
	UpstreamNetworkError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";

/**
 * Shared error -> user-message mapping for upstream-backed commands.
 * Messages never include magnets, tokens, keys, or request URLs.
 */
export function upstreamErrorMessage(error: unknown): string {
	if (error instanceof UpstreamTimeoutError) {
		return "The request timed out. The upstream service is slow right now — try again in a moment.";
	}
	if (error instanceof UpstreamApiError) {
		if (error.code === "DUPLICATE_ITEM") {
			return "That download is already on your TorBox account.";
		}
		// TorBox `detail` messages are documented as user-friendly and may be
		// forwarded to users; they are sanitized at the service boundary.
		return `TorBox could not complete the request: ${error.message}`;
	}
	if (error instanceof UpstreamStatusError) {
		if (error.status === 401 || error.status === 403) {
			return "The upstream service rejected the configured credentials. Ask the bot owner to check them.";
		}
		if (error.status === 429) {
			return "The upstream service is rate limiting us right now. Try again in a minute.";
		}
		return `The upstream service returned an error (HTTP ${error.status}). Try again later.`;
	}
	if (error instanceof UpstreamParseError) {
		return "The upstream service returned an unexpected response. Please try again later.";
	}
	if (error instanceof UpstreamNetworkError) {
		return "Could not reach the upstream service. Please try again later.";
	}
	return "Something went wrong while handling that request. Please try again later.";
}

/** Log an upstream failure by classification only (never the payload). */
export function logUpstreamFailure(context: string, error: unknown): void {
	console.warn(
		`${context}: ${error instanceof Error ? error.name : "unknown"}`,
	);
}

/**
 * Log a Discord REST failure with sanitized structured diagnostics.
 *
 * When `error` is a {@link DiscordApiError}, logs a structured object
 * containing only the safe fields Discord's normalized error already
 * carries: `status`, `code`, `discordMessage`, and `fieldErrors`. These
 * never include webhook URLs, interaction tokens, custom IDs, option
 * values, hashes, magnets, API keys, request bodies, or raw Discord
 * response bodies — the `DiscordApiError` class enforces that at the
 * boundary.
 *
 * For any other error, falls back to the classification-only
 * {@link logUpstreamFailure} so no upstream payload can leak.
 */
export function logDiscordApiFailure(
	context: string,
	error: unknown,
): void {
	if (error instanceof DiscordApiError) {
		console.warn(context, {
			status: error.status,
			code: error.code,
			discordMessage: error.discordMessage,
			fieldErrors: error.fieldErrors,
		});
		return;
	}
	logUpstreamFailure(context, error);
}

/**
 * Edit the original interaction response, swallowing follow-up failures
 * (there is nothing more we can do if Discord rejects the edit).
 */
export async function safeEditOriginal(
	interaction: DiscordInteraction,
	content: string,
): Promise<void> {
	try {
		await editOriginalResponse(interaction.application_id, interaction.token, {
			content,
		});
	} catch (error) {
		logDiscordApiFailure("failed to edit interaction response", error);
	}
}
