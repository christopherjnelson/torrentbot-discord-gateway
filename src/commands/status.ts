import { authorizeGuild, guildAuthMessage, type AppConfig } from "../config";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import { type DiscordInteraction } from "../discord/types";
import { listTorrents } from "../services/torbox";
import type { TorboxTorrent } from "../types/torbox";
import {
	DISCORD_CONTENT_LIMIT,
	formatBytes,
	sanitizeInline,
	truncate,
} from "../utils/format";
import {
	logUpstreamFailure,
	safeEditOriginal,
	upstreamErrorMessage,
} from "./shared";

export const STATUS_COMMAND_NAME = "status";
const MAX_STATUS_ENTRIES = 10;

/**
 * TorBox reports `progress` either as a 0-1 fraction or a 0-100 percentage
 * depending on endpoint version (not explicitly documented). Normalize to a
 * 0-100 integer for display.
 */
export function progressPercent(progress: number): number {
	const percent = progress <= 1 ? progress * 100 : progress;
	return Math.min(100, Math.max(0, Math.round(percent)));
}

function formatTorrentLine(torrent: TorboxTorrent, index: number): string {
	const parts: string[] = [
		formatBytes(torrent.size),
		sanitizeInline(torrent.download_state, 30),
		`${progressPercent(torrent.progress)}%`,
	];
	if (torrent.seeds > 0) {
		parts.push(`${torrent.seeds} seeds`);
	}
	if (torrent.cached) {
		parts.push("cached");
	}
	return `**${index + 1}.** \`${sanitizeInline(torrent.name, 90)}\` — ${parts.join(" · ")}`;
}

/** Build the /status message. Never includes download URLs or file paths. */
export function formatStatusMessage(torrents: readonly TorboxTorrent[]): string {
	if (torrents.length === 0) {
		return "No downloads on your TorBox account yet.";
	}
	const shown = torrents.slice(0, MAX_STATUS_ENTRIES);
	const lines = [
		`**TorBox downloads (${torrents.length} total):**`,
		...shown.map(formatTorrentLine),
	];
	if (torrents.length > shown.length) {
		lines.push(`_Showing ${shown.length} of ${torrents.length}._`);
	}
	return truncate(lines.join("\n"), DISCORD_CONTENT_LIMIT);
}

async function completeStatus(
	interaction: DiscordInteraction,
	config: AppConfig,
): Promise<void> {
	// apiKey presence is checked by handleStatusCommand before deferring.
	const apiKey = config.torboxApiKey as string;

	let content: string;
	try {
		const torrents = await listTorrents({
			apiKey,
			timeoutMs: config.upstreamTimeoutMs,
		});
		content = formatStatusMessage(torrents);
	} catch (error) {
		logUpstreamFailure("status failed", error);
		content = upstreamErrorMessage(error);
	}

	await safeEditOriginal(interaction, content);
}

/**
 * Handle `/status`. Restricted to members of an authorized Discord guild
 * because the bot is backed by a single TorBox account; the list is that
 * account's data and is only shown ephemerally to authorized users.
 */
export function handleStatusCommand(
	interaction: DiscordInteraction,
	config: AppConfig,
	ctx: ExecutionContext,
): Response {
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

	ctx.waitUntil(completeStatus(interaction, config));
	return deferredMessageResponse(true);
}
