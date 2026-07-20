/**
 * Register (or unregister) TorrentBot's guild-scoped slash commands.
 *
 * Usage:
 *   npm run discord:register      # PUT the full command set (idempotent)
 *   npm run discord:unregister    # PUT an empty set (removes guild commands)
 *
 * Reads DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, and DISCORD_BOT_TOKEN from
 * the environment (loaded from .dev.vars via `node --env-file-if-exists`).
 * Values are never printed. Guild-scoped only: global commands are never
 * touched. Safe to run repeatedly (bulk-overwrite semantics).
 */

const {
	DISCORD_APPLICATION_ID,
	DISCORD_GUILD_ID,
	DISCORD_BOT_TOKEN,
} = process.env;

const missingVariables = [
	["DISCORD_APPLICATION_ID", DISCORD_APPLICATION_ID],
	["DISCORD_GUILD_ID", DISCORD_GUILD_ID],
	["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
]
	.filter(([, value]) => !value)
	.map(([name]) => name);

if (missingVariables.length > 0) {
	console.error(
		`Missing environment variables: ${missingVariables.join(", ")}\n` +
			"Set them in .dev.vars (see .dev.vars.example) or export them first.",
	);
	process.exit(1);
}

const commands = [
	{
		name: "search",
		description: "Search TorBox Voyager for torrents",
		type: 1,
		options: [
			{
				name: "query",
				description: "What to search for",
				type: 3,
				required: true,
			},
		],
	},
	{
		name: "add",
		description: "Add a magnet URI to TorBox (authorized users only)",
		type: 1,
		options: [
			{
				name: "magnet",
				description: "The magnet URI to download",
				type: 3,
				required: true,
			},
		],
	},
	{
		name: "status",
		description: "Show TorBox download status (authorized users only)",
		type: 1,
		options: [],
	},
];

const unregister = process.argv.includes("--unregister");
const payload = unregister ? [] : commands;

const endpoint =
	`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}` +
	`/guilds/${DISCORD_GUILD_ID}/commands`;

let response;
try {
	response = await fetch(endpoint, {
		method: "PUT",
		headers: {
			Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
} catch {
	console.error("Could not reach the Discord API (network error).");
	process.exit(1);
}

const body = await response.text();

if (!response.ok) {
	console.error(
		`Discord returned ${response.status} ${response.statusText}.\n` +
			"Check that DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, and " +
			"DISCORD_BOT_TOKEN are correct, and that the bot is in the guild.",
	);
	process.exit(1);
}

let registered = [];
try {
	registered = JSON.parse(body);
} catch {
	console.error("Discord returned an unreadable response body.");
	process.exit(1);
}

if (unregister) {
	console.log("Removed all guild-scoped commands.");
} else {
	console.log(
		`Registered ${registered.length} guild command(s): ` +
			registered.map((command) => `/${command.name}`).join(", "),
	);
}
