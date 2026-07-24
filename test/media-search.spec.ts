import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_GUILD_ID,
	TEST_USER_ID,
} from "./helpers";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	buildMediaCustomId,
	digestComponentQuery,
	type MediaComponentPayload,
} from "../src/utils/signing";

type CapturedMenu = {
	content: string;
	components: Array<{
		type: number;
		components: Array<{
			type: number;
			custom_id: string;
			options: Array<{
				label: string;
				value: string;
				description: string;
			}>;
		}>;
	}>;
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
	fetchMock.deactivate();
});

function tmdbSearchPath(mediaType: "movie" | "tv"): RegExp {
	return new RegExp(`^/3/search/${mediaType}\\?`);
}

async function openMediaMenu(
	mediaType: "movie" | "tv",
	query: string,
	results: unknown[],
): Promise<CapturedMenu> {
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: tmdbSearchPath(mediaType) })
		.reply(200, JSON.stringify({ results }));
	const { captured } = interceptOriginalResponseEdit();
	const { ctx, response } = await dispatchInteraction(
		JSON.stringify(
			makeCommandInteraction("search", [
				{
					name: mediaType,
					type: 1,
					options: [{ name: "query", type: 3, value: query }],
				},
			]),
		),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	expect(await response.json()).toEqual({
		type: 5,
		data: { flags: 64 },
	});
	await waitOnExecutionContext(ctx);
	return captured[0].body as CapturedMenu;
}

function componentFromMenu(
	menu: CapturedMenu,
	value: string,
	overrides: Parameters<typeof makeComponentInteraction>[0] = {},
) {
	const select = menu.components[0].components[0];
	return makeComponentInteraction({
		data: { custom_id: select.custom_id, values: [value] },
		message: { content: menu.content, components: menu.components },
		...overrides,
	});
}

describe("TMDB movie disambiguation", () => {
	it("renders canonical title/year choices and the exact-search fallback", async () => {
		const menu = await openMediaMenu("movie", "star wars", [
			{
				id: 11,
				title: "Star Wars",
				original_title: "Star Wars",
				release_date: "1977-05-25",
			},
			{
				id: 12,
				title: "Star Wars: The Clone Wars",
				release_date: "",
			},
		]);
		expect(menu.content).toBe("Choose a movie for **star wars**:");
		const select = menu.components[0].components[0];
		expect(select.custom_id.length).toBeLessThanOrEqual(100);
		expect(select.options).toHaveLength(3);
		expect(select.options[0]).toMatchObject({
			label: "Star Wars",
			description: "1977 • Movie",
		});
		expect(select.options[1].description).toBe("Year unknown • Movie");
		expect(select.options[2].label).toBe("Search exactly as entered");
		for (const option of select.options) {
			expect(option.value.length).toBeLessThanOrEqual(100);
			expect(option.value).not.toContain("Star Wars");
		}
	});

	it("re-fetches movie details and searches Prowlarr with canonical title and year", async () => {
		const menu = await openMediaMenu("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		let detailsAuth = "";
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply((options) => {
				detailsAuth = (options.headers as Record<string, string>)
					.authorization;
				return {
					statusCode: 200,
					data: JSON.stringify({
						id: 11,
						title: "Star Wars",
						original_title: "Star Wars",
						release_date: "1977-05-25",
					}),
				};
			});
		let prowlarrQuery = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((options) => {
				prowlarrQuery = new URL(`https://prowlarr.test${options.path}`)
					.searchParams.get("query") ?? "";
				return { statusCode: 200, data: "[]" };
			});
		const { captured } = interceptOriginalResponseEdit();
		const selected = menu.components[0].components[0].options[0].value;
		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, selected)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect((await response.json()) as object).toMatchObject({
			type: 7,
			data: { components: [] },
		});
		await waitOnExecutionContext(ctx);
		expect(detailsAuth).toBe("Bearer test-tmdb-read-token");
		expect(prowlarrQuery).toBe("Star Wars 1977");
		expect(captured[0].body.content).toBe(
			"No results found for `Star Wars 1977`.",
		);
	});

	it("uses only the canonical title when details have no valid year", async () => {
		const menu = await openMediaMenu("movie", "future movie", [
			{ id: 22, title: "Future Movie", release_date: "" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/22" })
			.reply(200, JSON.stringify({ id: 22, title: "Future Movie" }));
		let prowlarrQuery = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((options) => {
				prowlarrQuery = new URL(`https://prowlarr.test${options.path}`)
					.searchParams.get("query") ?? "";
				return { statusCode: 200, data: "[]" };
			});
		interceptOriginalResponseEdit();
		const selected = menu.components[0].components[0].options[0].value;
		const { ctx } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, selected)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(prowlarrQuery).toBe("Future Movie");
	});
});

describe("TMDB TV disambiguation", () => {
	it("uses TV details and builds Canonical Name YYYY", async () => {
		const menu = await openMediaMenu("tv", "the office", [
			{ id: 2316, name: "The Office", first_air_date: "2005-03-24" },
		]);
		expect(menu.content).toBe("Choose a TV series for **the office**:");
		expect(
			menu.components[0].components[0].options[0].description,
		).toBe("2005 • TV");
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/2316" })
			.reply(
				200,
				JSON.stringify({
					id: 2316,
					name: "The Office",
					first_air_date: "2005-03-24",
				}),
			);
		let prowlarrQuery = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((options) => {
				prowlarrQuery = new URL(`https://prowlarr.test${options.path}`)
					.searchParams.get("query") ?? "";
				return { statusCode: 200, data: "[]" };
			});
		interceptOriginalResponseEdit();
		const selected = menu.components[0].components[0].options[0].value;
		const { ctx } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, selected)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(prowlarrQuery).toBe("The Office 2005");
	});
});

describe("TMDB exact-search escape hatch and component security", () => {
	it("bypasses details and preserves a 200-character original query", async () => {
		const query = "q".repeat(200);
		const menu = await openMediaMenu("movie", query, [
			{ id: 11, title: "A Result", release_date: "2000-01-01" },
		]);
		const select = menu.components[0].components[0];
		expect(select.custom_id.length).toBeLessThanOrEqual(100);
		expect(select.options.every((option) => option.value.length <= 100)).toBe(
			true,
		);

		let prowlarrQuery = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((options) => {
				prowlarrQuery = new URL(`https://prowlarr.test${options.path}`)
					.searchParams.get("query") ?? "";
				return { statusCode: 200, data: "[]" };
			});
		interceptOriginalResponseEdit();
		const fallback = select.options.at(-1)?.value as string;
		const { ctx } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, fallback)),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TMDB_READ_ACCESS_TOKEN: "",
			},
		);
		await waitOnExecutionContext(ctx);
		expect(prowlarrQuery).toBe(query);
	});

	it("reversibly preserves Markdown, backslashes, and internal controls", async () => {
		const query = "odd **title** \\\\ cut\nnext";
		const menu = await openMediaMenu("movie", query, [
			{ id: 30, title: "Odd Title", release_date: "2001-01-01" },
		]);
		expect(menu.content).toContain("\\*\\*title\\*\\*");
		expect(menu.content).toContain("\\u000a");
		let prowlarrQuery = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((options) => {
				prowlarrQuery = new URL(`https://prowlarr.test${options.path}`)
					.searchParams.get("query") ?? "";
				return { statusCode: 200, data: "[]" };
			});
		interceptOriginalResponseEdit();
		const fallback =
			menu.components[0].components[0].options.at(-1)?.value as string;
		const { ctx } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, fallback)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(prowlarrQuery).toBe(query);
	});

	it("rejects the wrong requester without upstream calls", async () => {
		const menu = await openMediaMenu("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		const selected = menu.components[0].components[0].options[0].value;
		const { response } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(menu, selected, {
					member: { user: { id: "other-user" } },
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("someone else's");
	});

	it("rejects an expired media component", async () => {
		const query = "star wars";
		const menu = await openMediaMenu("movie", query, [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		const digest = await digestComponentQuery(query);
		const expired: MediaComponentPayload = {
			action: "media",
			userId: TEST_USER_ID,
			infoHash: "",
			expiry: Date.now() - 1_000,
			mediaType: "movie",
			queryDigest: digest,
		};
		const customId = await buildMediaCustomId(
			expired,
			TEST_SIGNING_SECRET,
		);
		const selected = menu.components[0].components[0].options[0].value;
		const interaction = componentFromMenu(menu, selected);
		interaction.data = { custom_id: customId, values: [selected] };
		const { response } = await dispatchInteraction(
			JSON.stringify(interaction),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("expired or is invalid");
	});

	it("isolates a details failure and never falls through to Prowlarr", async () => {
		const menu = await openMediaMenu("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(500, "private provider response");
		const { captured } = interceptOriginalResponseEdit();
		const selected = menu.components[0].components[0].options[0].value;
		const { ctx } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, selected)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(captured[0].body.content).toBe(
			"The media lookup service is unavailable right now. Please try again.",
		);
	});

	it("keeps logs free of tokens, raw queries, and selected titles", async () => {
		const query = "private raw query";
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			fetchMock
				.get("https://api.themoviedb.org")
				.intercept({ path: tmdbSearchPath("movie") })
				.reply(401, "token title and raw body");
			const { captured } = interceptOriginalResponseEdit();
			const { ctx } = await dispatchInteraction(
				JSON.stringify(
					makeCommandInteraction("search", [
						{
							name: "movie",
							type: 1,
							options: [{ name: "query", type: 3, value: query }],
						},
					]),
				),
				{
					COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
					TMDB_READ_ACCESS_TOKEN: "do-not-log-token",
				},
			);
			await waitOnExecutionContext(ctx);
			expect(captured[0].body.content).toContain("unavailable");
			const logged = JSON.stringify([
				...infoSpy.mock.calls,
				...warnSpy.mock.calls,
			]);
			expect(logged).not.toContain(query);
			expect(logged).not.toContain("do-not-log-token");
			expect(logged).not.toContain("token title and raw body");
		} finally {
			infoSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("preserves guild and DM authorization on media commands", async () => {
		for (const overrides of [
			{ guild_id: "987654321098765432" },
			{ guild_id: undefined },
		]) {
			const { response } = await dispatchInteraction(
				JSON.stringify(
					makeCommandInteraction(
						"search",
						[
							{
								name: "movie",
								type: 1,
								options: [
									{ name: "query", type: 3, value: "star wars" },
								],
							},
						],
						overrides,
					),
				),
				{ TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID },
			);
			const body = (await response.json()) as {
				data: { flags?: number; content: string };
			};
			expect(body.data.flags).toBe(64);
			expect(body.data.content).toMatch(/authorized server|not enabled/);
		}
	});
});

describe("TMDB empty and failure responses", () => {
	it("returns the movie no-result guidance without components", async () => {
		const menu = await openMediaMenu("movie", "nothing", []);
		expect(menu.content).toBe(
			"No matching movies were found. Try `/search general` to search exactly as entered.",
		);
		expect(menu.components).toBeUndefined();
	});
});
