import { getConfig, isAllowedTorboxUser, type AppConfig } from "../config";
import {
	createFollowupMessage,
	editFollowupMessage,
	DiscordApiError,
} from "../discord/client";
import {
	messageResponse,
	updateMessageResponse,
} from "../discord/responses";
import {
	getInvokerId,
	type ComponentData,
	type DiscordInteraction,
} from "../discord/types";
import {
	createTorrent,
	findTorrentByHash,
	requestDownloadLink,
	selectDownloadTarget,
	waitForTorrentReady,
	type TorrentReadiness,
} from "../services/torbox";
import type { TorboxTorrent } from "../types/torbox";
import {
	UpstreamApiError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";
import { formatBytes, sanitizeInline } from "../utils/format";
import type { TorrentResult } from "../types/search";
import { formatResultDescription } from "./search";
import {
	logUpstreamFailure,
	upstreamErrorMessage,
} from "./shared";
import {
	parseAndVerifyCustomId,
	createPayload,
	buildCustomId,
	DISCORD_ID_LIMIT,
	MAX_SELECT_OPTIONS,
	SELECT_OPTION_CAP,
} from "../utils/signing";

/**
 * Handle a Discord message-component interaction (select menu choice).
 *
 * Flow (all pre-ack checks are CPU-only, well within Discord's 3-second
 * initial-response window):
 * 1. Validate the signed component payload, requester binding, and the
 *    TorBox allowlist. Failures answer ephemerally and leave the search
 *    select menu untouched.
 * 2. ACK with UPDATE_MESSAGE (type 7) clearing the components, which removes
 *    the select menu from the search results message without a loading
 *    state.
 * 3. In the background: submit to TorBox, run a bounded readiness poll, and
 *    report the outcome in an ephemeral followup message.
 */
export async function handleComponentInteraction(
	interaction: DiscordInteraction,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const config = getConfig(env);

	// Must be a component interaction with data.
	const data = interaction.data as ComponentData | undefined;
	if (!data?.custom_id) {
		return messageResponse(
			"Invalid component interaction",
			true,
		);
	}

	// Verify the signing secret is configured.
	if (!config.componentSigningSecret) {
		return messageResponse(
			"Component interactions are not configured on this bot.",
			true,
		);
	}

	// Get the selected info hash from the option value first (quick validation).
	const selectedHash = data.values?.[0];
	if (!selectedHash || !isValidHash(selectedHash)) {
		return messageResponse(
			"Invalid selection. Please try again.",
			true,
		);
	}

	// Verify the signed payload (HMAC-SHA-256, CPU-only).
	const payload = await parseAndVerifyCustomId(
		data.custom_id,
		config.componentSigningSecret,
	);
	if (!payload) {
		return messageResponse(
			"This selection has expired or is invalid. Please run `/search` again.",
			true,
		);
	}

	// Check that the selecting user is the original requester.
	const invokerId = getInvokerId(interaction);
	if (invokerId !== payload.userId) {
		return messageResponse(
			"You cannot use someone else's search result menu.",
			true,
		);
	}

	// Check allowlist.
	if (!isAllowedTorboxUser(config, invokerId)) {
		return messageResponse(
			"You are not authorized to add downloads on this bot.",
			true,
		);
	}

	// Check TorBox is configured.
	if (!config.torboxApiKey) {
		return messageResponse(
			"TorBox is not configured on this bot.",
			true,
		);
	}

	// ACK by removing the select menu from the search results message, then
	// do the TorBox work in the background.
	ctx.waitUntil(
		processComponentInteraction(interaction, selectedHash, config),
	);
	return updateMessageResponse({ components: [] });
}

/** Log a Discord follow-up failure with only sanitized diagnostics. */
function logDiscordEditFailure(error: unknown): void {
	if (error instanceof DiscordApiError) {
		console.warn("failed to edit interaction response: discord API error", {
			status: error.status,
			code: error.code,
			message: error.discordMessage,
			fieldErrors: error.fieldErrors,
		});
		return;
	}
	logUpstreamFailure("failed to edit interaction response", error);
}

/**
 * Background phase: post an ephemeral progress message, run the TorBox
 * flow, and edit the progress message with the final result. Every branch
 * ends in a user-visible edit; Discord follow-up failures can only be
 * logged (there is no remaining channel to the user).
 */
async function processComponentInteraction(
	interaction: DiscordInteraction,
	selectedHash: string,
	config: AppConfig,
): Promise<void> {
	let progressMessageId: string;
	try {
		progressMessageId = await createFollowupMessage(
			interaction.application_id,
			interaction.token,
			{ content: "Adding to TorBox..." },
		);
	} catch (error) {
		logDiscordEditFailure(error);
		return;
	}

	const content = await addAndAwaitDownload(selectedHash, config);

	try {
		await editFollowupMessage(
			interaction.application_id,
			interaction.token,
			progressMessageId,
			{ content },
		);
	} catch (error) {
		logDiscordEditFailure(error);
	}
}

/** Map a readiness-poll failure to a user message (the add already happened). */
function pollErrorMessage(heading: string, error: unknown): string {
	const suffix = "Use `/status` to check it later.";
	if (error instanceof UpstreamTimeoutError) {
		return `${heading}\n\nTorBox status checks timed out, so TorrentBot couldn't confirm it's ready. ${suffix}`;
	}
	if (
		(error instanceof UpstreamStatusError &&
			(error.status === 401 || error.status === 403)) ||
		(error instanceof UpstreamApiError &&
			(error.code === "BAD_TOKEN" ||
				error.code === "NO_AUTH" ||
				error.code === "AUTH_ERROR"))
	) {
		return `${heading}\n\nTorBox rejected the configured credentials while checking its status. Ask the bot owner to check them.`;
	}
	if (error instanceof UpstreamParseError) {
		return `${heading}\n\nTorBox returned an unexpected response while checking its status. ${suffix}`;
	}
	return `${heading}\n\nTorrentBot couldn't check whether it's ready yet. ${suffix}`;
}

function formatTitleLine(torrent: TorboxTorrent): string {
	return `**${sanitizeInline(torrent.name, 100)}**`;
}

/**
 * Submit the selected torrent to TorBox and run the bounded readiness poll.
 * Returns the final user-facing message. Magnets, API keys, and download
 * URLs are never logged; the download URL only appears in the returned
 * (ephemeral) message content.
 */
async function addAndAwaitDownload(
	selectedHash: string,
	config: AppConfig,
): Promise<string> {
	const torbox = {
		apiKey: config.torboxApiKey as string,
		timeoutMs: config.upstreamTimeoutMs,
	};
	const magnetUri = `magnet:?xt=urn:btih:${selectedHash}`;

	// 1. Submit, or resolve the existing torrent on duplicate.
	let torrentId: number;
	let heading = "Added to TorBox.";
	try {
		const created = await createTorrent(magnetUri, torbox);
		torrentId = created.torrent_id;
	} catch (error) {
		if (
			!(error instanceof UpstreamApiError) ||
			error.code !== "DUPLICATE_ITEM"
		) {
			logUpstreamFailure("component add failed", error);
			return upstreamErrorMessage(error);
		}
		// The item already exists: locate it by its info hash, the stable
		// documented identifier (never by title).
		let existing: TorboxTorrent | null;
		try {
			existing = await findTorrentByHash(selectedHash, torbox);
		} catch (lookupError) {
			logUpstreamFailure("component duplicate lookup failed", lookupError);
			return "That download is already on your TorBox account, but TorrentBot couldn't check its status. Use `/status` to view your downloads.";
		}
		if (!existing) {
			return "That download is already on your TorBox account, but TorrentBot couldn't locate it. Use `/status` to view your downloads.";
		}
		torrentId = existing.id;
		heading = "Already on TorBox.";
	}

	// 2. Bounded readiness poll.
	let readiness: TorrentReadiness;
	try {
		readiness = await waitForTorrentReady(torrentId, torbox, {
			intervalMs: config.torboxPollIntervalMs,
			maxAttempts: config.torboxPollMaxAttempts,
		});
	} catch (error) {
		logUpstreamFailure("component readiness poll failed", error);
		return pollErrorMessage(heading, error);
	}

	if (readiness.status === "not-found") {
		return `${heading}\n\nThe torrent could no longer be found on the TorBox account. Use \`/status\` to check it.`;
	}

	if (readiness.status === "processing") {
		const title = readiness.torrent
			? `\n\n${formatTitleLine(readiness.torrent)}`
			: "";
		return `${heading}${title}\nTorBox is still processing this torrent (ID \`${torrentId}\`). Use \`/status\` to check it later.`;
	}

	// 3. Ready: pick the download target and request the temporary link.
	const torrent = readiness.torrent;
	const target = selectDownloadTarget(torrent);
	let url: string;
	try {
		url = await requestDownloadLink({
			...torbox,
			torrentId,
			...(target.kind === "file"
				? { fileId: target.file.id }
				: { zip: true }),
		});
	} catch (error) {
		// The URL is never logged; only the error classification.
		logUpstreamFailure("component download link failed", error);
		return "The torrent was added, but TorrentBot could not generate a download link yet.\nUse `/status` to check it later.";
	}

	if (target.kind === "file") {
		const meta = `\`${sanitizeInline(target.file.name, 80)}\` (${formatBytes(target.file.size)})`;
		return `${heading}\n\n${formatTitleLine(torrent)}\nReady to download:\n[Download file](${url}) — ${meta}`;
	}
	const readyLine =
		torrent.files.length > 1
			? `Ready to download (${torrent.files.length} files):`
			: "Ready to download:";
	return `${heading}\n\n${formatTitleLine(torrent)}\n${readyLine}\n[Download archive (zip)](${url})`;
}

/**
 * Build select menu components for search results.
 * Returns null if no results have valid info hashes.
 */
export async function buildSearchComponents(
	results: readonly TorrentResult[],
	userId: string,
	signingSecret: string,
): Promise<object[] | null> {
	const selectable = results
		.filter((r) => r.infoHash && isValidHash(r.infoHash))
		.slice(0, SELECT_OPTION_CAP);

	if (selectable.length === 0) {
		return null;
	}

	// Build a signed custom_id for this search. The payload binds the
	// interaction to the original requester and includes an expiry.
	const payload = createPayload(userId, ""); // hash not needed in custom_id
	const customId = await buildCustomId(payload, signingSecret);

	// Each option's value is the info hash directly. The custom_id signature
	// validates the user and expiry; the option value is validated as a
	// proper info hash before use.
		const options = selectable.map((result) => {
			const rawLabel = sanitizeInline(result.title, 100);
			const value = result.infoHash as string;
			if (value.length > DISCORD_ID_LIMIT) {
				throw new Error("select option value exceeds Discord 100-char limit");
			}
			if (rawLabel.length > DISCORD_ID_LIMIT) {
				throw new Error("select option label exceeds Discord 100-char limit");
			}
			const description = formatResultDescription(result);
			return {
				label: rawLabel,
				value,
				description: description.length > 0 ? description : undefined,
			};
		});

	// Fail-safe invariant checks before sending to Discord.
	if (customId.length > DISCORD_ID_LIMIT) {
		throw new Error("search select custom_id exceeds Discord 100-char limit");
	}
	if (options.length > MAX_SELECT_OPTIONS) {
		throw new Error("too many select options for Discord");
	}
	if (options.length > SELECT_OPTION_CAP) {
		throw new Error("search select exceeds feature option cap");
	}

	return [
		{
			type: 1, // ActionRow
			components: [
				{
					type: 3, // StringSelect
					custom_id: customId,
					placeholder: "Add a result to TorBox",
					options,
				},
			],
		},
	];
}

function isValidHash(hash: string): boolean {
	return /^[a-fA-F0-9]{40}$/.test(hash);
}
