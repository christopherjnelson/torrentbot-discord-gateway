export interface DiscordCommandOption {
	name: string;
	description: string;
	type: number;
	required?: boolean;
	options?: DiscordCommandOption[];
}

export interface DiscordCommand {
	name: string;
	description: string;
	type: number;
	options: DiscordCommandOption[];
}

export const commands: DiscordCommand[];
