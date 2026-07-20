import { authorizeGuild, guildAuthMessage, type AppConfig } from "../config";
import {
	deferredMessageResponse,
	messageResponse,
} from "../discord/responses";
import { type DiscordInteraction } from "../discord/types";
import {
	listTorrents,
	requestDownloadLink,
	selectDownloadTarget,
} from "../services/torbox";
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

/**
 * A status entry pairs a torrent with an optional temporary download URL.
 * The URL is present only for ready torrents (`download_finished === true`)
 * whose link was successfully generated; it is `null` for processing
 * torrents or when link generation failed (the torrent is still shown).
 */
export interface StatusEntry {
	torrent: TorboxTorrent;
	url: string | null;
}

/**
 * Format one status line. Ready torrents with a URL get a concise
 * `[Download](url)` link on its own line; processing torrents and failed
 * link generations show status metadata only — never a placeholder link.
 */
function formatTorrentLine(entry: StatusEntry, index: number): string {
	const parts: string[] = [
		formatBytes(entry.torrent.size),
		sanitizeInline(entry.torrent.download_state, 30),
		`${progressPercent(entry.torrent.progress)}%`,
	];
	if (entry.torrent.seeds > 0) {
		parts.push(`${entry.torrent.seeds} seeds`);
	}
	if (entry.torrent.cached) {
		parts.push("cached");
	}
	const base = `**${index + 1}.** \`${sanitizeInline(entry.torrent.name, 90)}\` — ${parts.join(" · ")}`;
	if (entry.url) {
		return `${base}\n[Download](${entry.url})`;
	}
	return base;
}

/**
 * Build the /status message from enriched entries. Never includes download
 * URLs for processing torrents, file paths, or magnets. The output is
 * truncated to Discord's 2000-char content limit.
 *
 * @param entries  The (already capped) status entries to display.
 * @param total    The total number of torrents on the account (may exceed
 *                 `entries.length` when the list is truncated).
 */
export function formatStatusMessage(
	entries: readonly StatusEntry[],
	total: number,
): string {
	if (total === 0) {
		return "No downloads on your TorBox account yet.";
	}
	const shown = entries.slice(0, MAX_STATUS_ENTRIES);
	const lines = [
		`**TorBox downloads (${total} total):**`,
		...shown.map(formatTorrentLine),
	];
	if (total > shown.length) {
		lines.push(`_Showing ${shown.length} of ${total}._`);
	}
	return truncate(lines.join("\n"), DISCORD_CONTENT_LIMIT);
}

/**
 * Generate temporary download links for ready torrents, sequentially and
 * best-effort. Uses the same rules as the selection workflow
 * (`selectDownloadTarget`): exactly one file → a direct link; zero or
 * multiple files → a whole-torrent ZIP link.
 *
 * Each link request is isolated: a failure (HTTP, parse, non-HTTPS URL,
 * timeout) logs a sanitized classification and leaves that entry's URL
 * `null` so the torrent is still shown without a link. At most
 * `MAX_STATUS_ENTRIES` requests are made. Requests are sequential to match
 * the existing component-flow style and avoid overwhelming TorBox.
 */
async function enrichWithDownloadLinks(
	torrents: readonly TorboxTorrent[],
	apiKey: string,
	timeoutMs: number,
): Promise<StatusEntry[]> {
	const entries: StatusEntry[] = [];
	for (const torrent of torrents) {
		let url: string | null = null;
		if (torrent.download_finished) {
			try {
				const target = selectDownloadTarget(torrent);
				url = await requestDownloadLink({
					apiKey,
					timeoutMs,
					torrentId: torrent.id,
					...(target.kind === "file"
						? { fileId: target.file.id }
						: { zip: true }),
				});
			} catch (error) {
				logUpstreamFailure("status download link failed", error);
			}
		}
		entries.push({ torrent, url });
	}
	return entries;
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
		const shown = torrents.slice(0, MAX_STATUS_ENTRIES);
		const entries = await enrichWithDownloadLinks(
			shown,
			apiKey,
			config.upstreamTimeoutMs,
		);
		content = formatStatusMessage(entries, torrents.length);
	} catch (error) {
		logUpstreamFailure("status failed", error);
		content = upstreamErrorMessage(error);
	}

	await safeEditOriginal(interaction, content);
}

/**
 * Handle `/status`. Restricted to members of an authorized Discord guild
 * because the bot is backed by a single TorBox account; the list is that
 * account's data and is only shown ephemerally to authorized users. Ready
 * torrents include temporary TorBox download links; processing torrents
 * are status-only.
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
