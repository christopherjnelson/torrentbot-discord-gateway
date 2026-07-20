import { UpstreamStatusError } from "../utils/errors";
import { fetchText } from "../utils/http";

/**
 * Minimal Discord REST client for interaction follow-ups.
 *
 * Follow-up webhook endpoints authenticate with the interaction token itself
 * (no bot token required). The token is valid for 15 minutes.
 *
 * Security notes:
 * - The interaction token is embedded in request URLs only; it is never
 *   logged, and upstream error types never carry URLs.
 * - Only message `content` is sent; no embeds, no attachments.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface FollowupMessage {
	content: string;
	components?: object[];
}

/**
 * Edit the original response to an interaction (used after a deferred ACK).
 * PATCH /webhooks/{application.id}/{interaction.token}/messages/@original
 */
export async function editOriginalResponse(
	applicationId: string,
	interactionToken: string,
	message: FollowupMessage,
	timeoutMs?: number,
): Promise<void> {
	const url =
		`${DISCORD_API_BASE}/webhooks/${applicationId}` +
		`/${interactionToken}/messages/@original`;

	const body: Record<string, unknown> = {
		content: message.content,
		allowed_mentions: { parse: [] },
	};
	if (message.components) {
		body.components = message.components;
	}

	const { status } = await fetchText(url, {
		service: "discord",
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs,
	});

	if (status < 200 || status >= 300) {
		throw new UpstreamStatusError("discord", status);
	}
}
