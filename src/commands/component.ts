import { getConfig, isAllowedTorboxUser, type AppConfig } from "../config";
import {
	editOriginalResponse,
	DiscordApiError,
} from "../discord/client";
import {
	messageResponse,
} from "../discord/responses";
import {
	getInvokerId,
	type ComponentData,
	type DiscordInteraction,
} from "../discord/types";
import { createTorrent } from "../services/torbox";
import { sanitizeInline } from "../utils/format";
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
 * Validates the signed payload, checks authorization, and submits to TorBox.
 */
export function handleComponentInteraction(
	interaction: DiscordInteraction,
	env: Env,
	ctx: ExecutionContext,
): Response {
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

	// Acknowledge immediately and process in the background.
	ctx.waitUntil(
		processComponentInteraction(interaction, data, selectedHash, config),
	);
	return messageResponse(
		"Adding to TorBox...",
		true,
	);
}

/** Log a Discord edit failure with only sanitized diagnostics. */
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

async function processComponentInteraction(
	interaction: DiscordInteraction,
	data: ComponentData,
	selectedHash: string,
	config: AppConfig,
): Promise<void> {
	// Now do the async verification.
	const payload = await parseAndVerifyCustomId(
		data.custom_id,
		config.componentSigningSecret as string,
	);
	if (!payload) {
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content:
						"This selection has expired or is invalid. Please run `/search` again.",
				},
			);
		} catch (error) {
			logDiscordEditFailure(error);
		}
		return;
	}

	// Check that the selecting user is the original requester.
	const invokerId = getInvokerId(interaction);
	if (invokerId !== payload.userId) {
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{ content: "You cannot use someone else's search result menu." },
			);
		} catch (error) {
			logDiscordEditFailure(error);
		}
		return;
	}

	// Check allowlist.
	if (!isAllowedTorboxUser(config, invokerId)) {
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{
					content:
						"You are not authorized to add downloads on this bot.",
				},
			);
		} catch (error) {
			logDiscordEditFailure(error);
		}
		return;
	}

	// Reconstruct the magnet URI.
	const magnetUri = `magnet:?xt=urn:btih:${selectedHash}`;

	// Check TorBox is configured.
	if (!config.torboxApiKey) {
		try {
			await editOriginalResponse(
				interaction.application_id,
				interaction.token,
				{ content: "TorBox is not configured on this bot." },
			);
		} catch (error) {
			logDiscordEditFailure(error);
		}
		return;
	}

	// Submit to TorBox.
	let content: string;
	try {
		const created = await createTorrent(magnetUri, {
			apiKey: config.torboxApiKey as string,
			timeoutMs: config.upstreamTimeoutMs,
		});
		content =
			"Added to TorBox.\n" +
			"Added to TorBox.\n" +
			"**ID:** `" + created.torrent_id + "`\n" +
			"**Hash:** `" + sanitizeInline(created.hash, 64) + "`";
	} catch (error) {
		logUpstreamFailure("component add failed", error);
		content = upstreamErrorMessage(error);
	}

	// Edit the original response with the result and disable components.
	try {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content, components: [] },
		);
	} catch (error) {
		logDiscordEditFailure(error);
	}
}

/**
 * Build select menu components for search results.
 * Returns null if no results have valid info hashes.
 */
export async function buildSearchComponents(
	results: readonly { title: string; infoHash: string | null }[],
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
		return {
			label: rawLabel,
			value,
			description: `Hash: ${value.slice(0, 16)}...`,
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
