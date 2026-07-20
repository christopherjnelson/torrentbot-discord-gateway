import { getConfig } from "../config";
import { routeInteraction } from "../discord/interactions";
import { errorResponse } from "../discord/responses";
import { parseInteraction } from "../discord/types";
import { verifyDiscordRequest } from "../discord/verify";

/**
 * POST /discord/interactions
 *
 * Pipeline: signature verification -> JSON parse -> payload validation ->
 * interaction routing. Raw bodies, tokens, and payloads are never logged.
 */
export async function handleDiscordInteractions(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const config = getConfig(env);
	if (!config.discordPublicKey) {
		return errorResponse("Discord public key is not configured", 500);
	}

	const verification = await verifyDiscordRequest(
		request,
		config.discordPublicKey,
	);
	if (!verification.valid) {
		return errorResponse(
			verification.reason === "missing-headers"
				? "Missing Discord signature headers"
				: "Invalid request signature",
			401,
		);
	}

	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(verification.rawBody);
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	const interaction = parseInteraction(parsedBody);
	if (!interaction) {
		return errorResponse("Invalid interaction payload", 400);
	}

	return routeInteraction(interaction, env, ctx);
}
