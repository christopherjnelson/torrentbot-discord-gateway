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
import type { MediaDetails, TvDetails } from "../types/media";
import type { TorboxTorrent } from "../types/torbox";
import {
	UpstreamApiError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../utils/errors";
import { formatBytes, sanitizeInline } from "../utils/format";
import type { TorrentResult } from "../types/search";
import { completeMediaLookup, completeSearch } from "./search";
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
import { progressPercent } from "./status";
import {
	actionRow,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	BUTTON_SECONDARY,
	button,
	errorEmbed,
	mediaDetailsEmbed,
	queryFromFooter,
	releaseOptionDescription,
	statusEmbed,
	validateMessagePayload,
	type DiscordMessagePayload,
} from "../discord/presentation";
import {
	parseAndVerifyCustomId,
	createPayload,
	buildCustomId,
	DISCORD_ID_LIMIT,
	isValidInfoHash,
	MAX_SELECT_OPTIONS,
	SELECT_OPTION_CAP,
	createSeasonPayload,
	buildWorkflowCustomId,
	createWorkflowPayload,
	digestComponentQuery,
	signPayload,
	verifySignature,
	type WorkflowComponentPayload,
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
 * 2. ACK with UPDATE_MESSAGE (type 7), replacing the controls with a visible
 *    progress state while asynchronous work continues.
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

	if ("mediaId" in payload) {
		const workflowPayload = payload as WorkflowComponentPayload;
		if (workflowPayload.action === "cancel") {
			return updateMessageResponse({
				content: "Search cancelled.",
				embeds: [],
				components: [],
			});
		}
		if (workflowPayload.action === "new-search") {
			return updateMessageResponse({
				content: "Run `/search` to start a new media search.",
				embeds: [],
				components: [],
			});
		}
		const originalQuery = queryFromFooter(interaction.message?.embeds);
		if (
			originalQuery === null ||
			originalQuery.length === 0 ||
			originalQuery.length > 200 ||
			(await digestComponentQuery(originalQuery)) !==
				workflowPayload.queryDigest
		) {
			return messageResponse(
				"This selection has expired or is invalid. Please run `/search` again.",
				true,
			);
		}
		if (workflowPayload.action === "release") {
			if (!config.torboxApiKey) {
				return messageResponse(
					"TorBox is not configured on this bot.",
					true,
				);
			}
			const selectedHash = await extractReleaseHash(
				interaction,
				workflowPayload,
				config.componentSigningSecret,
			);
			if (!selectedHash) {
				return messageResponse(
					"Invalid or stale release selection. Please search again.",
					true,
				);
			}
			ctx.waitUntil(
				processComponentInteraction(
					interaction,
					selectedHash,
					config,
					workflowPayload,
				),
			);
			return updateMessageResponse({
				content: "",
				embeds: [
					statusEmbed("Adding to TorBox", "Processing", {
						description: "The selected release is being added.",
					}),
				],
				components: [],
			});
		}
		ctx.waitUntil(
			processWorkflowComponentInteraction(
				interaction,
				workflowPayload,
				originalQuery,
				config,
			),
		);
		if (workflowPayload.action === "movie-search") {
			return updateMessageResponse({
				content: "",
				embeds: [
					statusEmbed("Searching releases", "Searching", {
						description:
							"Finding matching releases and checking TorBox availability.",
					}),
				],
				components: [],
			});
		}
		return deferredUpdateMessageResponse();
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
		if (payload.mediaType !== "movie") {
			return deferredUpdateMessageResponse();
		}
		const isExactSearch = selection.kind === "fallback";
		return updateMessageResponse({
			content: "",
			embeds: [
				statusEmbed(
					isExactSearch
						? "Searching releases"
						: "Loading movie details",
					isExactSearch ? "Searching" : "Loading",
					{
						description: isExactSearch
							? "Finding matching releases and checking TorBox availability."
							: "Retrieving the selected title's details.",
					},
				),
			],
			components: [],
		});
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
			ctx.waitUntil(
				completeSearch(
					interaction,
					selection.query,
					config,
					createWorkflowPayload({
						userId: payload.userId,
						action: "release",
						mediaType: "tv",
						mediaId: payload.seriesId,
						page: payload.page,
						queryDigest: payload.queryDigest,
						expiry: payload.expiry,
					}),
				),
			);
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
				const view = {
					content: "",
					embeds: [
						mediaDetailsEmbed(details, selection.query, {
							step: "Choose complete series, specials, or a season",
						}),
					],
					components,
				};
				validateMessagePayload(view);
				await editOriginalResponse(
					interaction.application_id,
					interaction.token,
					view,
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
		await editMovieDetails(interaction, details, selection.query, payload, config);
		return;
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
}

async function editMovieDetails(
	interaction: DiscordInteraction,
	details: MediaDetails,
	originalQuery: string,
	sourcePayload: { userId: string; queryDigest: string; expiry: number },
	config: AppConfig,
): Promise<void> {
	const base = createWorkflowPayload({
		userId: sourcePayload.userId,
		action: "movie-search",
		mediaType: "movie",
		mediaId: details.id,
		queryDigest: sourcePayload.queryDigest,
		expiry: sourcePayload.expiry,
	});
	const components = [
		actionRow(
			button({
				label: "Search Releases",
				style: BUTTON_PRIMARY,
				customId: await buildWorkflowCustomId(
					base,
					config.componentSigningSecret as string,
				),
			}),
			button({
				label: "Search Exactly as Entered",
				style: BUTTON_SECONDARY,
				customId: await buildWorkflowCustomId(
					{ ...base, action: "exact" },
					config.componentSigningSecret as string,
				),
			}),
			button({
				label: "Back",
				style: BUTTON_SECONDARY,
				customId: await buildWorkflowCustomId(
					{ ...base, action: "back-results" },
					config.componentSigningSecret as string,
				),
			}),
			button({
				label: "Cancel",
				style: BUTTON_DANGER,
				customId: await buildWorkflowCustomId(
					{ ...base, action: "cancel" },
					config.componentSigningSecret as string,
				),
			}),
		),
	];
	const view: DiscordMessagePayload = {
		content: "",
		embeds: [
			mediaDetailsEmbed(details, originalQuery, {
				step: "Review the movie and choose how to search",
			}),
		],
		components,
	};
	validateMessagePayload(view);
	await editOriginalResponse(
		interaction.application_id,
		interaction.token,
		view,
	);
}

async function editTvDetails(
	interaction: DiscordInteraction,
	details: TvDetails,
	originalQuery: string,
	payload: WorkflowComponentPayload,
	config: AppConfig,
): Promise<void> {
	const seasonPayload = createSeasonPayload(
		payload.userId,
		details.id,
		payload.page,
		payload.queryDigest,
		payload.expiry,
	);
	const view: DiscordMessagePayload = {
		content: "",
		embeds: [
			mediaDetailsEmbed(details, originalQuery, {
				step: "Choose complete series, specials, or a season",
			}),
		],
		components: await buildSeasonComponents(
			details,
			originalQuery,
			seasonPayload,
			config.componentSigningSecret as string,
		),
	};
	validateMessagePayload(view);
	await editOriginalResponse(
		interaction.application_id,
		interaction.token,
		view,
	);
}

async function processWorkflowComponentInteraction(
	interaction: DiscordInteraction,
	payload: WorkflowComponentPayload,
	originalQuery: string,
	config: AppConfig,
): Promise<void> {
	try {
		if (payload.action === "exact") {
			await completeSearch(interaction, originalQuery, config, {
				...payload,
				action: "release",
			});
			return;
		}
		if (payload.action === "back-results") {
			if (payload.mediaType === "general") {
				await completeSearch(interaction, originalQuery, config, {
					...payload,
					action: "release",
				});
				return;
			}
			await completeMediaLookup(
				interaction,
				payload.mediaType,
				originalQuery,
				config,
			);
			return;
		}
		if (
			!config.tmdbReadAccessToken ||
			payload.mediaType === "general" ||
			payload.mediaId <= 0
		) {
			throw new Error("workflow media state unavailable");
		}
		if (payload.mediaType === "movie") {
			const details = await getTmdbDetails("movie", payload.mediaId, {
				readAccessToken: config.tmdbReadAccessToken,
				timeoutMs: config.upstreamTimeoutMs,
			});
			if (payload.action === "movie-search") {
				const query = details.year
					? `${details.title} ${details.year}`
					: details.title;
				await completeSearch(interaction, query, config, {
					...payload,
					action: "release",
				});
				return;
			}
			if (payload.action === "back-details") {
				await editMovieDetails(
					interaction,
					details,
					originalQuery,
					payload,
					config,
				);
				return;
			}
		}
		if (payload.mediaType === "tv") {
			const details = await getTmdbDetails("tv", payload.mediaId, {
				readAccessToken: config.tmdbReadAccessToken,
				timeoutMs: config.upstreamTimeoutMs,
			});
			if (
				payload.action === "previous" ||
				payload.action === "next" ||
				payload.action === "back-details"
			) {
				if (payload.page >= seasonPageCount(details.seasons)) {
					await editSeasonSelectionUnavailable(interaction);
					return;
				}
				await editTvDetails(
					interaction,
					details,
					originalQuery,
					payload,
					config,
				);
				return;
			}
			const seasonNumber =
				payload.action === "tv-complete"
					? "complete"
					: payload.action === "tv-specials"
						? 0
						: null;
			if (
				seasonNumber === null ||
				(seasonNumber === 0 &&
					!details.seasons.some((season) => season.seasonNumber === 0))
			) {
				await editSeasonSelectionUnavailable(interaction);
				return;
			}
			const query = buildTvSeasonQuery(details.title, seasonNumber);
			if (!query) {
				await editSeasonSelectionUnavailable(interaction);
				return;
			}
			await completeSearch(interaction, query, config, {
				...payload,
				action: "release",
				seasonNumber: seasonNumber === "complete" ? -1 : seasonNumber,
			});
			return;
		}
		throw new Error("unsupported workflow action");
	} catch (error) {
		logUpstreamFailure("media workflow failed", error);
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content: "",
					embeds: [
						errorEmbed(
							"Media lookup unavailable",
							"The media service could not be reached. Try again shortly.",
						),
					],
					components: [],
				},
			);
		} catch (discordError) {
			logDiscordApiFailure(
				"failed to edit interaction response",
				discordError,
			);
		}
	}
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
	await completeSearch(
		interaction,
		canonicalQuery,
		config,
		createWorkflowPayload({
			userId: payload.userId,
			action: "release",
			mediaType: "tv",
			mediaId: payload.seriesId,
			seasonNumber:
				selection.kind === "complete" ? -1 : selection.seasonNumber,
			page: payload.page,
			queryDigest: payload.queryDigest,
			expiry: payload.expiry,
		}),
	);
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
	workflowPayload?: WorkflowComponentPayload,
): Promise<void> {
	if (workflowPayload) {
		const content = await addAndAwaitDownload(selectedHash, config);
		const downloadUrl = /\]\((https:\/\/[^)]+)\)/.exec(content)?.[1];
		const title =
			interaction.message?.embeds?.[0]?.title ?? "TorBox download";
		const ready = content.includes("Ready to download") && downloadUrl;
		const processing = content.includes("still processing");
		const components: object[] = [];
		if (ready && downloadUrl) {
			components.push(
				actionRow(
					button({
						label: "Download",
						style: 5,
						url: downloadUrl,
					}),
					button({
						label: "New Search",
						style: BUTTON_SECONDARY,
						customId: await buildWorkflowCustomId(
							{ ...workflowPayload, action: "new-search" },
							config.componentSigningSecret as string,
						),
					}),
				),
			);
		}
		const safeDescription = content
			.replace(/\[Download[^\]]*\]\(https:\/\/[^)]+\)/g, "")
			.trim();
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content: "",
					embeds: [
						statusEmbed(
							title,
							ready
								? "Ready to download"
								: processing
									? "Processing"
									: "Action needed",
							{
								description: safeDescription,
								color: ready ? 0x57f287 : undefined,
							},
						),
					],
					components,
				},
			);
		} catch (error) {
			logDiscordApiFailure("failed to edit interaction response", error);
		}
		return;
	}
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
		const progress = readiness.torrent
			? ` Progress: ${progressPercent(readiness.torrent.progress)}%.`
			: "";
		return `${heading}${title}\nTorBox is still processing this torrent.${progress} Use \`/status\` to check it later.`;
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
	payloadOrUserId: WorkflowComponentPayload | string,
	signingSecret: string,
): Promise<object[] | null> {
	const payload =
		typeof payloadOrUserId === "string"
			? createWorkflowPayload({
					userId: payloadOrUserId,
					action: "release",
					mediaType: "general",
					queryDigest: await digestComponentQuery(""),
				})
			: payloadOrUserId;
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
		const infoHash = result.infoHash;
		if (typeof infoHash !== "string" || !isValidInfoHash(infoHash)) {
			continue;
		}
		const key = infoHash.toLowerCase();
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
		const signature = await signPayload(
			releaseSigningInput(infoHash, payload),
			signingSecret,
		);
		const value = `${infoHash}.${signature}`;
		const description = releaseOptionDescription(result);
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
	const customId = await buildWorkflowCustomId(payload, signingSecret);

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

	const rows: object[] = [
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
	const navigation: object[] = [];
	if (payload.mediaType !== "general" && payload.mediaId > 0) {
		navigation.push(
			button({
				label: "Back",
				style: BUTTON_SECONDARY,
				customId: await buildWorkflowCustomId(
					{ ...payload, action: "back-details" },
					signingSecret,
				),
			}),
		);
	}
	navigation.push(
		button({
			label: "Cancel",
			style: BUTTON_DANGER,
			customId: await buildWorkflowCustomId(
				{ ...payload, action: "cancel" },
				signingSecret,
			),
		}),
	);
	rows.push(actionRow(...navigation));
	return rows;
}

function releaseSigningInput(
	hash: string,
	payload: WorkflowComponentPayload,
): string {
	return [
		hash.toLowerCase(),
		payload.userId,
		payload.mediaType,
		String(payload.mediaId),
		payload.seasonNumber === null ? "n" : String(payload.seasonNumber),
		payload.queryDigest,
		String(Math.floor(payload.expiry / 1000)),
	].join(":");
}

async function extractReleaseHash(
	interaction: DiscordInteraction,
	payload: WorkflowComponentPayload,
	secret: string,
): Promise<string | null> {
	const selected = (interaction.data as ComponentData | undefined)?.values;
	if (!selected || selected.length !== 1) {
		return null;
	}
	const separator = selected[0].lastIndexOf(".");
	if (separator !== 40) {
		return null;
	}
	const hash = selected[0].slice(0, separator);
	const signature = selected[0].slice(separator + 1);
	if (
		!isValidInfoHash(hash) ||
		!/^[A-Za-z0-9_-]{22}$/.test(signature) ||
		!(await verifySignature(
			releaseSigningInput(hash, payload),
			signature,
			secret,
		))
	) {
		return null;
	}
	const visibleValues: string[] = [];
	for (const row of interaction.message?.components ?? []) {
		for (const component of row.components ?? []) {
			for (const option of component.options ?? []) {
				visibleValues.push(option.value);
			}
		}
	}
	return visibleValues.includes(selected[0]) ? hash : null;
}
