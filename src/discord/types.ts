/**
 * Minimal typed model of Discord interaction payloads, validated at the
 * boundary. Only the fields this Worker uses are modelled; everything else
 * is ignored (never logged, never echoed).
 *
 * Field semantics verified against the official Discord docs:
 * https://discord.com/developers/docs/interactions/receiving-and-responding
 */

export const INTERACTION_PING = 1;
export const INTERACTION_APPLICATION_COMMAND = 2;

export const APPLICATION_COMMAND_OPTION_STRING = 3;

export interface CommandOption {
	name: string;
	type: number;
	value?: string | number | boolean;
}

export interface ApplicationCommandData {
	name: string;
	options?: CommandOption[];
}

export interface DiscordInteraction {
	id: string;
	application_id: string;
	type: number;
	token: string;
	data?: ApplicationCommandData;
	guild_id?: string;
	member?: { user?: { id?: string } };
	user?: { id?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): CommandOption | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.name !== "string" || typeof value.type !== "number") {
		return null;
	}
	const option: CommandOption = { name: value.name, type: value.type };
	if (
		typeof value.value === "string" ||
		typeof value.value === "number" ||
		typeof value.value === "boolean"
	) {
		option.value = value.value;
	}
	return option;
}

/**
 * Validate an untrusted JSON body as a Discord interaction. Returns null for
 * structurally invalid payloads. Signature verification must happen before
 * this is called; this only guards against malformed/shape-shifted JSON.
 */
export function parseInteraction(raw: unknown): DiscordInteraction | null {
	if (!isRecord(raw)) {
		return null;
	}
	if (
		typeof raw.id !== "string" ||
		typeof raw.application_id !== "string" ||
		typeof raw.type !== "number" ||
		typeof raw.token !== "string"
	) {
		return null;
	}

	const interaction: DiscordInteraction = {
		id: raw.id,
		application_id: raw.application_id,
		type: raw.type,
		token: raw.token,
	};

	if (raw.guild_id !== undefined) {
		if (typeof raw.guild_id !== "string") {
			return null;
		}
		interaction.guild_id = raw.guild_id;
	}

	if (isRecord(raw.member) && isRecord(raw.member.user)) {
		interaction.member = {
			user:
				typeof raw.member.user.id === "string"
					? { id: raw.member.user.id }
					: undefined,
		};
	}

	if (isRecord(raw.user)) {
		interaction.user =
			typeof raw.user.id === "string" ? { id: raw.user.id } : undefined;
	}

	if (raw.data !== undefined) {
		if (!isRecord(raw.data) || typeof raw.data.name !== "string") {
			return null;
		}
		const data: ApplicationCommandData = { name: raw.data.name };
		if (raw.data.options !== undefined) {
			if (!Array.isArray(raw.data.options)) {
				return null;
			}
			data.options = raw.data.options
				.map(parseOption)
				.filter((option): option is CommandOption => option !== null);
		}
		interaction.data = data;
	}

	return interaction;
}

/** The Discord user ID of whoever invoked the interaction. */
export function getInvokerId(interaction: DiscordInteraction): string | undefined {
	return interaction.member?.user?.id ?? interaction.user?.id;
}

/** Read a named string option from an application command interaction. */
export function getStringOption(
	interaction: DiscordInteraction,
	name: string,
): string | undefined {
	const option = interaction.data?.options?.find(
		(candidate) => candidate.name === name,
	);
	if (option && typeof option.value === "string") {
		return option.value;
	}
	return undefined;
}
