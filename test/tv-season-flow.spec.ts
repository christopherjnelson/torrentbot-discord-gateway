import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
} from "./helpers";

type Component = {
	type: number;
	custom_id?: string;
	label?: string;
	options?: Array<{ label: string; value: string; description: string }>;
};
type View = {
	content?: string;
	embeds?: Array<{ title?: string; footer?: { text?: string } }>;
	components: Array<{ type: number; components: Component[] }>;
};

const SEASONS = [
	{ season_number: 0, episode_count: 7 },
	{ season_number: 1, episode_count: 7 },
	{ season_number: 3, episode_count: 13 },
];

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
beforeEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => fetchMock.deactivate());

function details(seasons: unknown[] = SEASONS) {
	return {
		id: 1396,
		name: "Breaking Bad",
		first_air_date: "2008-01-20",
		episode_run_time: [45],
		status: "Ended",
		seasons,
	};
}

async function openResults(): Promise<View> {
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
	const edits = interceptOriginalResponseEdit();
	const routed = await dispatchInteraction(
		JSON.stringify(
			makeCommandInteraction("search", [
				{
					name: "tv",
					type: 1,
					options: [{ name: "query", type: 3, value: "breaking bad" }],
				},
			]),
		),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	await waitOnExecutionContext(routed.ctx);
	return edits.captured[0].body as View;
}

async function openSeasons(seasons: unknown[] = SEASONS): Promise<View> {
	const results = await openResults();
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: "/3/tv/1396" })
		.reply(200, JSON.stringify(details(seasons)));
	const edits = interceptOriginalResponseEdit();
	const select = results.components[0].components[0];
	const routed = await dispatchInteraction(
		JSON.stringify(
			makeComponentInteraction({
				data: {
					custom_id: select.custom_id as string,
					values: [select.options?.[0]?.value as string],
				},
				message: results,
			}),
		),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	expect(await routed.response.json()).toEqual({ type: 6 });
	await waitOnExecutionContext(routed.ctx);
	return edits.captured[0].body as View;
}

function buttonInteraction(view: View, label: string) {
	const button = view.components
		.flatMap((row) => row.components)
		.find((component) => component.label === label);
	expect(button?.custom_id, `missing ${label} button`).toBeDefined();
	return makeComponentInteraction({
		data: { custom_id: button?.custom_id as string },
		message: view,
	});
}

function seasonInteraction(view: View, label: string) {
	const select = view.components
		.flatMap((row) => row.components)
		.find((component) => component.type === 3);
	const option = select?.options?.find((candidate) => candidate.label === label);
	expect(option, `missing ${label} option`).toBeDefined();
	return makeComponentInteraction({
		data: {
			custom_id: select?.custom_id as string,
			values: [option?.value as string],
		},
		message: view,
	});
}

function interceptProwlarr() {
	let query = "";
	fetchMock
		.get("https://prowlarr.test")
		.intercept({ path: /^\/api\/v1\/search/ })
		.reply((request) => {
			query =
				new URL(`https://prowlarr.test${request.path}`).searchParams.get(
					"query",
				) ?? "";
			return { statusCode: 200, data: "[]" };
		});
	return () => query;
}

async function choose(
	interaction: ReturnType<typeof makeComponentInteraction>,
	trustedSeasons: unknown[],
): Promise<string> {
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: "/3/tv/1396" })
		.reply(200, JSON.stringify(details(trustedSeasons)));
	const searched = interceptProwlarr();
	interceptOriginalResponseEdit();
	const routed = await dispatchInteraction(
		JSON.stringify(interaction),
		{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
	);
	await waitOnExecutionContext(routed.ctx);
	return searched();
}

describe("routed TV season workflow", () => {
	it("regression: selecting the TMDB result edits the original response with seasons", async () => {
		const view = await openSeasons();
		expect(view.embeds?.[0].title).toBe("Breaking Bad");
		expect(
			view.components
				.flatMap((row) => row.components)
				.find((component) => component.type === 3)
				?.options?.map((option) => option.label),
		).toEqual(["Specials", "Season 1", "Season 3"]);
	});

	it("searches Complete series only after its button is chosen", async () => {
		const view = await openSeasons();
		expect(await choose(buttonInteraction(view, "Complete Series"), SEASONS)).toBe(
			"Breaking Bad complete",
		);
	});

	it("maps Specials to S00", async () => {
		const view = await openSeasons();
		expect(await choose(buttonInteraction(view, "Specials"), SEASONS)).toBe(
			"Breaking Bad S00",
		);
	});

	it("maps a numbered season to a padded canonical query", async () => {
		const view = await openSeasons();
		expect(await choose(seasonInteraction(view, "Season 3"), SEASONS)).toBe(
			"Breaking Bad S03",
		);
	});

	it("exact search bypasses the second TMDB details lookup", async () => {
		const view = await openSeasons();
		const searched = interceptProwlarr();
		interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(buttonInteraction(view, "Search Exactly as Entered")),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TMDB_READ_ACCESS_TOKEN: "",
			},
		);
		await waitOnExecutionContext(routed.ctx);
		expect(searched()).toBe("breaking bad");
	});

	it("uses signed Previous/Next buttons for long season lists", async () => {
		const seasons = Array.from({ length: 46 }, (_, season_number) => ({
			season_number,
			episode_count: season_number + 1,
		}));
		const first = await openSeasons(seasons);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(200, JSON.stringify(details(seasons)));
		const edits = interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(buttonInteraction(first, "Next")),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(routed.ctx);
		const second = edits.captured[0].body as View;
		expect(
			second.components
				.flatMap((row) => row.components)
				.find((component) => component.type === 3)
				?.options?.map((option) => option.label),
		).toContain("Season 39");
		expect(
			second.components
				.flatMap((row) => row.components)
				.map((component) => component.label),
		).toContain("Previous");
	});

	it("rejects a season that disappeared from trusted details", async () => {
		const view = await openSeasons();
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(
				200,
				JSON.stringify(
					details(SEASONS.filter((season) => season.season_number !== 3)),
				),
			);
		const edits = interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(seasonInteraction(view, "Season 3")),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(routed.ctx);
		expect(edits.captured[0].body.content).toContain(
			"season selection is no longer available",
		);
	});

	it("Cancel removes all interactive controls", async () => {
		const view = await openSeasons();
		const { response } = await dispatchInteraction(
			JSON.stringify(buttonInteraction(view, "Cancel")),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(await response.json()).toMatchObject({
			type: 7,
			data: { content: "Search cancelled.", components: [] },
		});
	});
});
