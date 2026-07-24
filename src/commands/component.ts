import {
	authorizeGuild,
	getConfig,
	guildAuthMessage,
	type AppConfig,
} from "../config";
import {
	createFollowupMessage,
	editFollowupMessage,
	editOriginalResponse,
} from "../discord/client";
import {
	deferredUpdateMessageResponse,
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
import { getTmdbDetails } from "../services/tmdb";
import type { TvDetails } from "../types/media";
import type { TorboxTorrent } from "../types/torbox";
import {
	UpstreamApiError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";
import { formatBytes, sanitizeInline } from "../utils/format";
import type { TorrentResult } from "../types/search";
import { completeSearch, formatResultDescription } from "./search";
import { extractMediaSelection } from "./media";
import {
	buildSeasonComponents,
	buildTvSeasonQuery,
	extractSeasonSelection,
	formatSeasonHeading,
	nextSeasonPayload,
	seasonPageCount,
	type SeasonSelection,
} from "./season";
import {
	logDiscordApiFailure,
	logUpstreamFailure,
	upstreamErrorMessage,
} from "./shared";
import {
	parseAndVerifyCustomId,
	createPayload,
	buildCustomId,
	DISCORD_ID_LIMIT,
	isValidInfoHash,
	MAX_SELECT_OPTIONS,
	SELECT_OPTION_CAP,
	createSeasonPayload,
	type MediaComponentPayload,
	type SeasonComponentPayload,
} from "../utils/signing";

/**
 * Handle a Discord message-component interaction (select menu choice).
 *
 * Flow (all pre-ack checks are CPU-only, well within Discord's 3-second
 * initial-response window):
 * 1. Validate the signed component payload, requester binding, and the
 *    authorized-guild check. Failures answer ephemerally and leave the
 *    search select menu untouched.
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

	// Check that the interaction comes from an authorized guild.
	const authStatus = authorizeGuild(
		interaction.guild_id,
		config.torboxAllowedGuildIds,
	);
	if (authStatus !== "allowed") {
		return messageResponse(guildAuthMessage(authStatus), true);
	}

	if (payload.action === "media") {
		if (
			!config.prowlarrUrl ||
			!config.prowlarrApiKey
		) {
			return messageResponse(
				"Movie and TV lookup is not configured on this bot.",
				true,
			);
		}
		const selection = await extractMediaSelection(
			interaction,
			payload,
			config.componentSigningSecret,
		);
		if (!selection) {
			return messageResponse("Invalid selection. Please try again.", true);
		}
		if (selection.kind === "media" && !config.tmdbReadAccessToken) {
			return messageResponse(
				"Movie and TV lookup is not configured on this bot.",
				true,
			);
		}
		ctx.waitUntil(
			processMediaComponentInteraction(
				interaction,
				payload,
				selection,
				config,
			),
		);
		return deferredUpdateMessageResponse();
	}

	if (payload.action === "season") {
		if (!config.prowlarrUrl || !config.prowlarrApiKey) {
			return messageResponse(
				"TV lookup is not configured on this bot.",
				true,
			);
		}
		const selection = await extractSeasonSelection(
			interaction,
			payload,
			config.componentSigningSecret,
		);
		if (!selection) {
			return messageResponse(
				"That season selection is no longer available. Please run the search again.",
				true,
			);
		}
		if (selection.kind === "exact") {
			ctx.waitUntil(completeSearch(interaction, selection.query, config));
			return deferredUpdateMessageResponse();
		}
		if (!config.tmdbReadAccessToken) {
			return messageResponse(
				"TV lookup is not configured on this bot.",
				true,
			);
		}
		ctx.waitUntil(
			processSeasonComponentInteraction(
				interaction,
				payload,
				selection,
				config,
			),
		);
		return deferredUpdateMessageResponse();
	}

	// Release menus carry a BTIH hash as the selected option value.
	const selectedHash = data.values?.[0];
	if (!selectedHash || !isValidInfoHash(selectedHash)) {
		return messageResponse(
			"Invalid selection. Please try again.",
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

async function processMediaComponentInteraction(
	interaction: DiscordInteraction,
	payload: MediaComponentPayload,
	selection:
		| { kind: "media"; id: number; query: string }
		| { kind: "fallback"; query: string },
	config: AppConfig,
): Promise<void> {
	if (selection.kind === "fallback") {
		await completeSearch(interaction, selection.query, config);
		return;
	}

	let canonicalQuery: string;
	try {
		if (payload.mediaType === "tv") {
			const startedAt = Date.now();
			const details = await getTmdbDetails("tv", selection.id, {
				readAccessToken: config.tmdbReadAccessToken as string,
				timeoutMs: config.upstreamTimeoutMs,
			});
			console.info(
				JSON.stringify({
					operation: "tmdb_tv_details",
					outcome: "success",
					elapsedMs: Date.now() - startedAt,
					seriesId: details.id,
					seasonCount: details.seasons.length,
					page: 0,
				}),
			);
			const seasonPayload = createSeasonPayload(
				payload.userId,
				details.id,
				0,
				payload.queryDigest,
				payload.expiry,
			);
			const components = await buildSeasonComponents(
				details,
				selection.query,
				seasonPayload,
				config.componentSigningSecret as string,
			);
			try {
				await editOriginalResponse(
					interaction.application_id,
					interaction.token,
					{
						content: formatSeasonHeading(
							details.title,
							selection.query,
							details.seasons.length > 0,
						),
						components,
					},
				);
			} catch (error) {
				logDiscordApiFailure(
					"failed to edit interaction response",
					error,
				);
			}
			return;
		}

		const details = await getTmdbDetails("movie", selection.id, {
			readAccessToken: config.tmdbReadAccessToken as string,
			timeoutMs: config.upstreamTimeoutMs,
		});
		canonicalQuery = details.year
			? `${details.title} ${details.year}`
			: details.title;
		canonicalQuery = canonicalQuery.replace(/\s+/g, " ").trim();
	} catch (error) {
		logUpstreamFailure("tmdb details failed", error);
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content:
						"The media lookup service is unavailable right now. Please try again.",
				},
			);
		} catch (discordError) {
			logDiscordApiFailure(
				"failed to edit interaction response",
				discordError,
			);
		}
		return;
	}

	await completeSearch(interaction, canonicalQuery, config);
}

async function editSeasonSelectionUnavailable(
	interaction: DiscordInteraction,
): Promise<void> {
	try {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{
				content:
					"That season selection is no longer available. Please run the search again.",
			},
		);
	} catch (error) {
		logDiscordApiFailure("failed to edit interaction response", error);
	}
}

async function processSeasonComponentInteraction(
	interaction: DiscordInteraction,
	payload: SeasonComponentPayload,
	selection: Exclude<SeasonSelection, { kind: "exact" }>,
	config: AppConfig,
): Promise<void> {
	const startedAt = Date.now();
	let details: TvDetails;
	try {
		details = await getTmdbDetails("tv", payload.seriesId, {
			readAccessToken: config.tmdbReadAccessToken as string,
			timeoutMs: config.upstreamTimeoutMs,
		});
		console.info(
			JSON.stringify({
				operation: "tmdb_tv_details",
				outcome: "success",
				elapsedMs: Date.now() - startedAt,
				seriesId: details.id,
				seasonCount: details.seasons.length,
				page:
					selection.kind === "page"
						? selection.page
						: payload.page,
			}),
		);
	} catch (error) {
		logUpstreamFailure("tmdb details failed", error);
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content:
						"The media lookup service is unavailable right now. Please try again.",
				},
			);
		} catch (discordError) {
			logDiscordApiFailure(
				"failed to edit interaction response",
				discordError,
			);
		}
		return;
	}

	if (selection.kind === "page") {
		if (
			selection.page < 0 ||
			selection.page >= seasonPageCount(details.seasons)
		) {
			await editSeasonSelectionUnavailable(interaction);
			return;
		}
		try {
			const nextPayload = nextSeasonPayload(payload, selection.page);
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content: formatSeasonHeading(
						details.title,
						selection.query,
						details.seasons.length > 0,
					),
					components: await buildSeasonComponents(
						details,
						selection.query,
						nextPayload,
						config.componentSigningSecret as string,
					),
				},
			);
		} catch (error) {
			logDiscordApiFailure("failed to edit interaction response", error);
		}
		return;
	}

	if (
		selection.kind === "season" &&
		!details.seasons.some(
			(season) => season.seasonNumber === selection.seasonNumber,
		)
	) {
		await editSeasonSelectionUnavailable(interaction);
		return;
	}

	const canonicalQuery = buildTvSeasonQuery(
		details.title,
		selection.kind === "complete"
			? "complete"
			: selection.seasonNumber,
	);
	if (!canonicalQuery) {
		await editSeasonSelectionUnavailable(interaction);
		return;
	}
	await completeSearch(interaction, canonicalQuery, config);
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
		logDiscordApiFailure("failed to edit interaction response", error);
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
		logDiscordApiFailure("failed to edit interaction response", error);
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
 * Build select menu components for the already-normalized selectable
 * search results.
 *
 * The caller (`completeSearch`) is responsible for producing the
 * selectable set via `buildSelectableOptions(results, SELECT_OPTION_CAP)`,
 * which deduplicates by normalized info hash, drops empty-label results,
 * and caps at ten. This function keeps only defensive validation so a
 * malformed payload can never reach Discord:
 * - option label non-empty and <= 100 chars
 * - option value a valid 40-char BTIH hash and <= 100 chars
 * - optional description omitted when empty and <= 100 chars
 * - no more than ten options
 * - custom_id <= 100 chars
 *
 * Returns null if the selectable set is empty.
 */
export async function buildSearchComponents(
	selectable: readonly TorrentResult[],
	userId: string,
	signingSecret: string,
): Promise<object[] | null> {
	// Defensive: re-deduplicate in case a caller bypassed the normal path.
	const seen = new Set<string>();
	const options: {
		label: string;
		value: string;
		description?: string;
	}[] = [];
	for (const result of selectable) {
		if (options.length >= SELECT_OPTION_CAP) {
			break;
		}
		const value = result.infoHash;
		if (typeof value !== "string" || !isValidInfoHash(value)) {
			continue;
		}
		const key = value.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const label = sanitizeInline(result.title, 100);
		if (label.length === 0) {
			continue;
		}
		if (label.length > DISCORD_ID_LIMIT) {
			throw new Error("select option label exceeds Discord 100-char limit");
		}
		if (value.length > DISCORD_ID_LIMIT) {
			throw new Error("select option value exceeds Discord 100-char limit");
		}
		const description = formatResultDescription(result);
		options.push({
			label,
			value,
			description: description.length > 0 ? description : undefined,
		});
	}

	if (options.length === 0) {
		return null;
	}

	// Build a signed custom_id for this search. The payload binds the
	// interaction to the original requester and includes an expiry.
	const payload = createPayload(userId, ""); // hash not needed in custom_id
	const customId = await buildCustomId(payload, signingSecret);

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
					placeholder: "Select a release to download",
					options,
				},
			],
		},
	];
}
