/**
 * Guild-scoped Discord application command schema.
 *
 * Kept separate from the registration side effect so the exact payload can
 * be unit-tested without reading credentials or contacting Discord.
 */
export const commands = [
	{
		name: "search",
		description: "Search for torrents",
		type: 1,
		options: [
			{
				name: "general",
				description: "Search all configured Prowlarr indexers",
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
				name: "movie",
				description: "Find a movie and search releases",
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
				name: "tv",
				description: "Find a TV series and search releases",
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
