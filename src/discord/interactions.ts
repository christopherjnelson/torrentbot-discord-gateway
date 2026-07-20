import { getConfig } from "../config";
import { handleSearchCommand, SEARCH_COMMAND_NAME } from "../commands/search";
import {
	errorResponse,
	messageResponse,
	pongResponse,
} from "./responses";
import {
	INTERACTION_APPLICATION_COMMAND,
	INTERACTION_PING,
	type DiscordInteraction,
} from "./types";

/**
 * Route a verified Discord interaction to its handler.
 */
export function routeInteraction(
	interaction: DiscordInteraction,
	env: Env,
	ctx: ExecutionContext,
): Response {
	if (interaction.type === INTERACTION_PING) {
		return pongResponse();
	}

	if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
		const config = getConfig(env);
		switch (interaction.data?.name) {
			case SEARCH_COMMAND_NAME:
				return handleSearchCommand(interaction, config, ctx);
			default:
				return messageResponse(
					"Unknown command. This bot currently supports `/search`.",
					true,
				);
		}
	}

	return errorResponse("Unsupported interaction type", 400);
}
