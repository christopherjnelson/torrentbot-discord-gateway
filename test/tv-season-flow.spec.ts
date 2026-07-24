import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	buildSeasonCustomId,
	digestComponentQuery,
	type SeasonComponentPayload,
} from "../src/utils/signing";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_GUILD_ID,
	TEST_UNAUTHORIZED_GUILD_ID,
	TEST_USER_ID,
} from "./helpers";

type Menu = {
	content: string;
	allowed_mentions?: { parse: string[] };
	components: Array<{
		type: number;
		components: Array<{
			type: number;
			custom_id: string;
			placeholder: string;
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

function select(menu: Menu) {
	return menu.components[0].components[0];
}

function componentFromMenu(
	menu: Menu,
	value: string,
	overrides: Parameters<typeof makeComponentInteraction>[0] = {},
) {
	return makeComponentInteraction({
		data: { custom_id: select(menu).custom_id, values: [value] },
		message: { content: menu.content, components: menu.components },
		...overrides,
	});
}

function tvDetails(seasons: unknown[]) {
	return {
		id: 1396,
		name: "Breaking   Bad",
		original_name: "Breaking Bad",
		first_air_date: "2008-01-20",
		seasons,
	};
}

const BASE_SEASONS = [
	{ season_number: 0, episode_count: 5 },
	{ season_number: 1, episode_count: 7 },
	{ season_number: 3, episode_count: 13 },
	{ season_number: 100, episode_count: null },
];

async function openTvMediaMenu(query = "breaking bad"): Promise<Menu> {
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: /^\/3\/search\/tv\?/ })
		.reply(
			200,
			JSON.stringify({
				results: [
					{
						id: 1396,
						name: "Breaking Bad",
						first_air_date: "2008-01-20",
					},
				],
			}),
		);
	const { captured } = interceptOriginalResponseEdit();
	const { ctx, response } = await dispatchInteraction(
		JSON.stringify(
			makeCommandInteraction("search", [
				{
					name: "tv",
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
	return captured[0].body as Menu;
}

async function openSeasonMenu(
	seasons: unknown[] = BASE_SEASONS,
	query = "breaking bad",
): Promise<Menu> {
	const mediaMenu = await openTvMediaMenu(query);
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: "/3/tv/1396" })
		.reply(200, JSON.stringify(tvDetails(seasons)));
	const { captured } = interceptOriginalResponseEdit();
	const seriesValue = select(mediaMenu).options[0].value;
	const { ctx, response } = await dispatchInteraction(
		JSON.stringify(componentFromMenu(mediaMenu, seriesValue)),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	expect(await response.json()).toMatchObject({
		type: 6,
	});
	await waitOnExecutionContext(ctx);
	expect(captured).toHaveLength(1);
	return captured[0].body as Menu;
}

function option(menu: Menu, label: string) {
	const found = select(menu).options.find((candidate) => candidate.label === label);
	expect(found, `missing option ${label}`).toBeDefined();
	return found as NonNullable<typeof found>;
}

function interceptProwlarr(status = 200, body = "[]") {
	let query = "";
	fetchMock
		.get("https://prowlarr.test")
		.intercept({ path: /^\/api\/v1\/search/ })
		.reply((request) => {
			query =
				new URL(`https://prowlarr.test${request.path}`).searchParams.get(
					"query",
				) ?? "";
			return { statusCode: status, data: body };
		});
	return () => query;
}

async function chooseCanonicalOption(
	label: string,
	expectedQuery: string,
): Promise<void> {
	const menu = await openSeasonMenu();
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: "/3/tv/1396" })
		.reply(200, JSON.stringify(tvDetails(BASE_SEASONS)));
	const searched = interceptProwlarr();
	const { captured } = interceptOriginalResponseEdit();
	const { ctx, response } = await dispatchInteraction(
		JSON.stringify(componentFromMenu(menu, option(menu, label).value)),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	expect(await response.json()).toMatchObject({
		type: 6,
	});
	await waitOnExecutionContext(ctx);
	expect(searched()).toBe(expectedQuery);
	expect(captured[0].body.content).toBe(
		`No results found for \`${expectedQuery}\`.`,
	);
}

describe("TV season continuation", () => {
	it.each([
		["Complete series", "Breaking Bad complete"],
		["Specials", "Breaking Bad S00"],
		["Season 3", "Breaking Bad S03"],
		["Season 100", "Breaking Bad S100"],
	])("%s re-fetches trusted details and searches %s", async (label, query) => {
		await chooseCanonicalOption(label, query);
	});

	it("uses the original query unchanged for exact search without a details request", async () => {
		const original = "breaking bad fan edit";
		const menu = await openSeasonMenu(BASE_SEASONS, original);
		const searched = interceptProwlarr();
		interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(
					menu,
					option(menu, "Search exactly as entered").value,
				),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TMDB_READ_ACCESS_TOKEN: "",
			},
		);
		await waitOnExecutionContext(ctx);
		expect(searched()).toBe(original);
	});

	it("rejects a season that disappeared from the trusted details response", async () => {
		const menu = await openSeasonMenu();
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(
				200,
				JSON.stringify(
					tvDetails(BASE_SEASONS.filter((season) => season.season_number !== 3)),
				),
			);
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(menu, option(menu, "Season 3").value),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(captured[0].body.content).toContain(
			"season selection is no longer available",
		);
	});

	it("navigates to every later season with a signed requester-bound page", async () => {
		const seasons = Array.from({ length: 46 }, (_, seasonNumber) => ({
			season_number: seasonNumber,
			episode_count: seasonNumber + 1,
		}));
		const first = await openSeasonMenu(seasons);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(200, JSON.stringify(tvDetails(seasons)));
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(first, option(first, "Next seasons").value),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		const second = captured[0].body as Menu;
		expect(select(second).placeholder).toBe("Select a season (page 2/3)");
		expect(select(second).options.map((entry) => entry.label)).toContain(
			"Season 39",
		);
		expect(select(second).options).toHaveLength(23);
		expect(select(second).options.at(-1)?.label).toBe(
			"Search exactly as entered",
		);
	});

	it("surfaces a Prowlarr failure safely after a valid season selection", async () => {
		const menu = await openSeasonMenu();
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(200, JSON.stringify(tvDetails(BASE_SEASONS)));
		interceptProwlarr(500, "private upstream payload");
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(menu, option(menu, "Season 1").value),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(ctx);
		expect(captured[0].body.content).toBe(
			"The upstream service returned an error (HTTP 500). Try again later.",
		);
		expect(JSON.stringify(captured)).not.toContain("private upstream payload");
	});
});

describe("TV season component integrity", () => {
	it("rejects a tampered season option HMAC without an upstream request", async () => {
		const menu = await openSeasonMenu();
		const selected = option(menu, "Season 3");
		const tampered =
			selected.value.slice(0, -1) +
			(selected.value.endsWith("A") ? "B" : "A");
		selected.value = tampered;
		const { response } = await dispatchInteraction(
			JSON.stringify(componentFromMenu(menu, tampered)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain(
			"season selection is no longer available",
		);
	});

	it("rejects a tampered signed series ID", async () => {
		const menu = await openSeasonMenu();
		const customId = select(menu).custom_id;
		const tampered = customId.replace(":1396:", ":1397:");
		const interaction = componentFromMenu(
			menu,
			option(menu, "Season 1").value,
		);
		interaction.data = {
			custom_id: tampered,
			values: [option(menu, "Season 1").value],
		};
		const { response } = await dispatchInteraction(
			JSON.stringify(interaction),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("expired or is invalid");
	});

	it("rejects the wrong requester and unauthorized guild", async () => {
		const menu = await openSeasonMenu();
		const value = option(menu, "Season 1").value;
		const wrongUser = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(menu, value, {
					member: { user: { id: "other-user" } },
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(
			((await wrongUser.response.json()) as { data: { content: string } })
				.data.content,
		).toContain("someone else's");

		const wrongGuild = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(menu, value, {
					guild_id: TEST_UNAUTHORIZED_GUILD_ID,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID,
			},
		);
		expect(
			((await wrongGuild.response.json()) as { data: { content: string } })
				.data.content,
		).toBe("TorrentBot is not enabled for this server.");
	});

	it("rejects an expired season component", async () => {
		const query = "breaking bad";
		const menu = await openSeasonMenu(BASE_SEASONS, query);
		const expired: SeasonComponentPayload = {
			action: "season",
			userId: TEST_USER_ID,
			infoHash: "",
			expiry: Date.now() - 1_000,
			seriesId: 1396,
			page: 0,
			queryDigest: await digestComponentQuery(query),
		};
		const interaction = componentFromMenu(
			menu,
			option(menu, "Season 1").value,
		);
		interaction.data = {
			custom_id: await buildSeasonCustomId(
				expired,
				TEST_SIGNING_SECRET,
			),
			values: [option(menu, "Season 1").value],
		};
		const { response } = await dispatchInteraction(
			JSON.stringify(interaction),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("expired or is invalid");
	});
});

describe("TV details failure handling", () => {
	async function selectSeriesWithFailure(
		intercept: () => void,
		env: Record<string, string> = {},
	): Promise<string> {
		const mediaMenu = await openTvMediaMenu();
		intercept();
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				componentFromMenu(mediaMenu, select(mediaMenu).options[0].value),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET, ...env },
		);
		await waitOnExecutionContext(ctx);
		return captured[0].body.content as string;
	}

	it.each([401, 429, 500])(
		"handles TV details HTTP %s without exposing the response",
		async (status) => {
			const content = await selectSeriesWithFailure(() => {
				fetchMock
					.get("https://api.themoviedb.org")
					.intercept({ path: "/3/tv/1396" })
					.reply(status, "private TMDB response body");
			});
			expect(content).toBe(
				"The media lookup service is unavailable right now. Please try again.",
			);
			expect(content).not.toContain("private TMDB response body");
		},
	);

	it("handles malformed TV details JSON", async () => {
		const content = await selectSeriesWithFailure(() => {
			fetchMock
				.get("https://api.themoviedb.org")
				.intercept({ path: "/3/tv/1396" })
				.reply(200, "{broken");
		});
		expect(content).toContain("media lookup service is unavailable");
	});

	it("does not let missing canonical title metadata reach Prowlarr", async () => {
		const content = await selectSeriesWithFailure(() => {
			fetchMock
				.get("https://api.themoviedb.org")
				.intercept({ path: "/3/tv/1396" })
				.reply(
					200,
					JSON.stringify({ id: 1396, seasons: BASE_SEASONS }),
				);
		});
		expect(content).toContain("media lookup service is unavailable");
	});

	it("handles a TV details timeout", async () => {
		const content = await selectSeriesWithFailure(
			() => {
				fetchMock
					.get("https://api.themoviedb.org")
					.intercept({ path: "/3/tv/1396" })
					.reply(200, JSON.stringify(tvDetails(BASE_SEASONS)))
					.delay(100);
			},
			{ UPSTREAM_TIMEOUT_MS: "10" },
		);
		expect(content).toContain("media lookup service is unavailable");
	});

	it("handles a TV details network failure", async () => {
		const content = await selectSeriesWithFailure(() => {
			// No details interceptor: disabled network access becomes a
			// normalized UpstreamNetworkError at the TMDB boundary.
		});
		expect(content).toContain("media lookup service is unavailable");
	});
});
