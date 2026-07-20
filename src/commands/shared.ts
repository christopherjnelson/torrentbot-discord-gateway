import { editOriginalResponse } from "../discord/client";
import type { DiscordInteraction } from "../discord/types";
import {
	TorznabResponseError,
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
	if (error instanceof TorznabResponseError) {
		return `The search service could not complete the request: ${error.message}`;
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
		logUpstreamFailure("failed to edit interaction response", error);
	}
}
