import { getConfig } from "../config";
import { ADD_COMMAND_NAME, handleAddCommand } from "../commands/add";
import { handleSearchCommand, SEARCH_COMMAND_NAME } from "../commands/search";
import {
	handleStatusCommand,
	STATUS_COMMAND_NAME,
} from "../commands/status";
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
			case ADD_COMMAND_NAME:
				return handleAddCommand(interaction, config, ctx);
			case STATUS_COMMAND_NAME:
				return handleStatusCommand(interaction, config, ctx);
			default:
				return messageResponse(
					"Unknown command. This bot supports `/search`, `/add`, and `/status`.",
					true,
				);
		}
	}

	return errorResponse("Unsupported interaction type", 400);
}
