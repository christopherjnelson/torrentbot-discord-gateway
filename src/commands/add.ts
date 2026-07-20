import { authorizeGuild, guildAuthMessage, type AppConfig } from "../config";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import {
	getStringOption,
	type DiscordInteraction,
} from "../discord/types";
import { createTorrent } from "../services/torbox";
import { isValidMagnetUri } from "../utils/magnet";
import { sanitizeInline } from "../utils/format";
import {
	logUpstreamFailure,
	safeEditOriginal,
	upstreamErrorMessage,
} from "./shared";

export const ADD_COMMAND_NAME = "add";

async function completeAdd(
	interaction: DiscordInteraction,
	magnetUri: string,
	config: AppConfig,
): Promise<void> {
	// apiKey presence is checked by handleAddCommand before deferring.
	const apiKey = config.torboxApiKey as string;

	let content: string;
	try {
		const created = await createTorrent(magnetUri, {
			apiKey,
			timeoutMs: config.upstreamTimeoutMs,
		});
		content =
			"Torrent added to TorBox.\n" +
			`**ID:** \`${created.torrent_id}\`\n` +
			`**Hash:** \`${sanitizeInline(created.hash, 64)}\``;
	} catch (error) {
		// Never log the magnet URI; classification only.
		logUpstreamFailure("add failed", error);
		content = upstreamErrorMessage(error);
	}

	await safeEditOriginal(interaction, content);
}

/**
 * Handle `/add magnet:<uri>`. Restricted to members of an authorized
 * Discord guild (TORBOX_ALLOWED_GUILD_IDS) because it submits downloads to
 * the owner's TorBox account. Responds ephemerally.
 */
export function handleAddCommand(
	interaction: DiscordInteraction,
	config: AppConfig,
	ctx: ExecutionContext,
): Response {
	const magnet = getStringOption(interaction, "magnet")?.trim();
	if (!magnet || !isValidMagnetUri(magnet)) {
		return messageResponse(
			"Invalid magnet URI. Usage: `/add magnet:<magnet:?xt=urn:btih:…>`",
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

	if (!config.torboxApiKey) {
		return messageResponse(
			"TorBox is not configured on this bot. The owner needs to set a TorBox API key.",
			true,
		);
	}

	ctx.waitUntil(completeAdd(interaction, magnet, config));
	return deferredMessageResponse(true);
}
