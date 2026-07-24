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
export const INTERACTION_MESSAGE_COMPONENT = 3;

export const APPLICATION_COMMAND_OPTION_STRING = 3;
export const APPLICATION_COMMAND_OPTION_SUBCOMMAND = 1;

export interface CommandOption {
	name: string;
	type: number;
	value?: string | number | boolean;
	options?: CommandOption[];
}

export interface ApplicationCommandData {
	name: string;
	options?: CommandOption[];
}

/** A select-option value chosen by the user. */
export interface ComponentData {
	custom_id: string;
	values?: string[];
}

export interface DiscordInteraction {
	id: string;
	application_id: string;
	type: number;
	token: string;
	data?: ApplicationCommandData | ComponentData;
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
	if (value.options !== undefined) {
		if (!Array.isArray(value.options)) {
			return null;
		}
		const options: CommandOption[] = [];
		for (const nested of value.options) {
			const parsed = parseOption(nested);
			if (!parsed) {
				return null;
			}
			options.push(parsed);
		}
		option.options = options;
	}
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
		if (!isRecord(raw.data)) {
			return null;
		}

		// Component interactions have custom_id; commands have name.
		if (typeof raw.data.custom_id === "string") {
			const data: ComponentData = { custom_id: raw.data.custom_id };
			if (Array.isArray(raw.data.values)) {
				data.values = raw.data.values.filter(
					(v): v is string => typeof v === "string",
				);
			}
			interaction.data = data;
		} else if (typeof raw.data.name === "string") {
			const data: ApplicationCommandData = { name: raw.data.name };
			if (raw.data.options !== undefined) {
				if (!Array.isArray(raw.data.options)) {
					return null;
				}
				const options: CommandOption[] = [];
				for (const rawOption of raw.data.options) {
					const option = parseOption(rawOption);
					if (!option) {
						return null;
					}
					options.push(option);
				}
				data.options = options;
			}
			interaction.data = data;
		}
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
	const data = interaction.data;
	if (!data || !("options" in data)) {
		return undefined;
	}
	const option = data.options?.find(
		(candidate) => candidate.name === name,
	);
	if (option && typeof option.value === "string") {
		return option.value;
	}
	return undefined;
}
