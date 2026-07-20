import { getConfig, isAllowedTorboxUser, type AppConfig } from "../config";
import { editOriginalResponse } from "../discord/client";
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

	// Parse and verify the signed custom_id (async, but we need to return
	// synchronously). We'll do the verification in the background and
	// acknowledge immediately.
	// Actually, we need to verify synchronously to reject invalid requests.
	// Let me restructure this...

	// For now, let me use a different approach: do the verification
	// synchronously by making parseAndVerifyCustomId synchronous.
	// Actually, HMAC verification requires crypto.subtle which is async.

	// The correct approach is to acknowledge the interaction immediately
	// (within 3 seconds), then do the verification and processing.
	// If the verification fails, we edit the original response with an error.

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
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content: "This selection has expired or is invalid. Please run `/search` again." },
		);
		return;
	}

	// Check that the selecting user is the original requester.
	const invokerId = getInvokerId(interaction);
	if (invokerId !== payload.userId) {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content: "You cannot use someone else's search result menu." },
		);
		return;
	}

	// Check allowlist.
	if (!isAllowedTorboxUser(config, invokerId)) {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content: "You are not authorized to add downloads on this bot." },
		);
		return;
	}

	// Reconstruct the magnet URI.
	const magnetUri = `magnet:?xt=urn:btih:${selectedHash}`;

	// Check TorBox is configured.
	if (!config.torboxApiKey) {
		await editOriginalResponse(
			interaction.application_id,
			interaction.token,
			{ content: "TorBox is not configured on this bot." },
		);
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
			`**ID:** \`${created.torrent_id}\`\n` +
			`**Hash:** \`${sanitizeInline(created.hash, 64)}\``;
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
		logUpstreamFailure("failed to edit interaction response", error);
	}
}

async function completeComponentAdd(
	interaction: DiscordInteraction,
	magnetUri: string,
	infoHash: string,
	config: AppConfig,
): Promise<void> {
	let content: string;
	try {
		const created = await createTorrent(magnetUri, {
			apiKey: config.torboxApiKey as string,
			timeoutMs: config.upstreamTimeoutMs,
		});
		content =
			"Added to TorBox.\n" +
			`**ID:** \`${created.torrent_id}\`\n` +
			`**Hash:** \`${sanitizeInline(created.hash, 64)}\``;
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
		logUpstreamFailure("failed to edit interaction response", error);
	}
}

function isValidHash(hash: string): boolean {
	return /^[a-fA-F0-9]{40}$/.test(hash);
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
		.slice(0, 5);

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
	const options = selectable.map((result) => ({
		label: sanitizeInline(result.title, 100),
		value: result.infoHash as string,
		description: `Hash: ${(result.infoHash as string).slice(0, 16)}...`,
	}));

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
