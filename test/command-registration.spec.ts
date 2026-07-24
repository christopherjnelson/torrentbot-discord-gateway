import { describe, expect, it } from "vitest";
import { commands } from "../scripts/command-schema.mjs";

describe("Discord command registration schema", () => {
	it("registers typed general, movie, and tv search subcommands", () => {
		const search = commands.find((command) => command.name === "search");
		expect(search).toBeDefined();
		expect(search?.options.map((option) => option.name)).toEqual([
			"general",
			"movie",
			"tv",
		]);
		for (const subcommand of search?.options ?? []) {
			expect(subcommand.type).toBe(1);
			expect(subcommand.options).toEqual([
				{
					name: "query",
					description: "What to search for",
					type: 3,
					required: true,
				},
			]);
		}
	});
});
