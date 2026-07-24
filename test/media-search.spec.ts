import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
} from "./helpers";

type View = {
	content?: string;
	embeds?: Array<{
		title?: string;
		description?: string;
		thumbnail?: { url?: string };
		footer?: { text?: string };
	}>;
	components: Array<{
		type: number;
		components: Array<{
			type: number;
			custom_id?: string;
			label?: string;
			style?: number;
			options?: Array<{
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

beforeEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => fetchMock.deactivate());

async function openMediaResults(
	mediaType: "movie" | "tv",
	query: string,
	results: unknown[],
): Promise<View> {
	fetchMock
		.get("https://api.themoviedb.org")
		.intercept({ path: new RegExp(`^/3/search/${mediaType}\\?`) })
		.reply(200, JSON.stringify({ results }));
	const { captured } = interceptOriginalResponseEdit();
	const { ctx } = await dispatchInteraction(
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
	await waitOnExecutionContext(ctx);
	return captured[0].body as View;
}

function selectInteraction(view: View, optionIndex = 0) {
	const select = view.components[0].components[0];
	return makeComponentInteraction({
		data: {
			custom_id: select.custom_id as string,
			values: [select.options?.[optionIndex]?.value as string],
		},
		message: view,
	});
}

function buttonInteraction(view: View, label: string) {
	const component = view.components
		.flatMap((row) => row.components)
		.find((candidate) => candidate.label === label);
	expect(component?.custom_id, `missing button ${label}`).toBeDefined();
	return makeComponentInteraction({
		data: { custom_id: component?.custom_id as string },
		message: view,
	});
}

function movieDetails() {
	return {
		id: 11,
		title: "Star Wars",
		original_title: "Star Wars",
		release_date: "1977-05-25",
		overview: "Luke begins a journey across the galaxy.",
		poster_path: "/star_wars.jpg",
		genres: [
			{ id: 12, name: "Adventure" },
			{ id: 878, name: "Science Fiction" },
		],
		runtime: 121,
		status: "Released",
	};
}

describe("guided TMDB media workflow", () => {
	it("keeps only TMDB matches in the dropdown and uses buttons for actions", async () => {
		const view = await openMediaResults("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
			{ id: 12, title: "The Clone Wars", release_date: "" },
		]);
		expect(view.components[0].components[0].options?.map((o) => o.label)).toEqual([
			"Star Wars",
			"The Clone Wars",
		]);
		expect(view.components[1].components.map((button) => button.label)).toEqual([
			"Search Exactly as Entered",
			"Cancel",
		]);
		expect(view.embeds?.[0].footer?.text).toContain("Original search:");
	});

	it("selecting a movie renders a poster-backed card before Prowlarr", async () => {
		const results = await openMediaResults("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(200, JSON.stringify(movieDetails()));
		const { captured } = interceptOriginalResponseEdit();
		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(selectInteraction(results)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(await response.json()).toEqual({ type: 6 });
		await waitOnExecutionContext(ctx);
		const card = captured[0].body as View;
		expect(card.embeds?.[0]).toMatchObject({
			title: "Star Wars",
			thumbnail: { url: "https://image.tmdb.org/t/p/w500/star_wars.jpg" },
		});
		expect(card.embeds?.[0].description).toContain("Movie • 1977");
		expect(card.components[0].components.map((button) => button.label)).toEqual([
			"Search Releases",
			"Search Exactly as Entered",
			"Back",
			"Cancel",
		]);
	});

	it("Search Releases uses the trusted canonical movie title and year", async () => {
		const results = await openMediaResults("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(200, JSON.stringify(movieDetails()));
		const firstEdit = interceptOriginalResponseEdit();
		const first = await dispatchInteraction(
			JSON.stringify(selectInteraction(results)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(first.ctx);
		const card = firstEdit.captured[0].body as View;

		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(200, JSON.stringify(movieDetails()));
		let searched = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((request) => {
				searched =
					new URL(`https://prowlarr.test${request.path}`).searchParams.get(
						"query",
					) ?? "";
				return { statusCode: 200, data: "[]" };
			});
		const secondEdit = interceptOriginalResponseEdit();
		const second = await dispatchInteraction(
			JSON.stringify(buttonInteraction(card, "Search Releases")),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(second.ctx);
		expect(searched).toBe("Star Wars 1977");
		expect(secondEdit.captured[0].body.embeds?.[0]).toMatchObject({
			title: "No releases found",
		});
	});

	it("selecting TV fetches details and renders seasons without Prowlarr", async () => {
		const results = await openMediaResults("tv", "breaking bad", [
			{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/1396" })
			.reply(
				200,
				JSON.stringify({
					id: 1396,
					name: "Breaking Bad",
					first_air_date: "2008-01-20",
					poster_path: "/breaking_bad.jpg",
					episode_run_time: [45],
					status: "Ended",
					seasons: [
						{ season_number: 0, episode_count: 7 },
						{ season_number: 1, episode_count: 7 },
					],
				}),
			);
		const { captured } = interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(selectInteraction(results)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(routed.ctx);
		const card = captured[0].body as View;
		expect(card.embeds?.[0].title).toBe("Breaking Bad");
		expect(card.components[0].components[0].options?.map((o) => o.label)).toEqual([
			"Specials",
			"Season 1",
		]);
		expect(card.components[1].components.map((button) => button.label)).toEqual([
			"Complete Series",
			"Specials",
			"Search Exactly as Entered",
		]);
	});

	it("exact search from results bypasses TMDB details", async () => {
		const results = await openMediaResults("movie", "fan edit", [
			{ id: 11, title: "A Movie", release_date: "2000-01-01" },
		]);
		let searched = "";
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((request) => {
				searched =
					new URL(`https://prowlarr.test${request.path}`).searchParams.get(
						"query",
					) ?? "";
				return { statusCode: 200, data: "[]" };
			});
		interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(buttonInteraction(results, "Search Exactly as Entered")),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(routed.ctx);
		expect(searched).toBe("fan edit");
	});

	it("rejects another requester before any continuation request", async () => {
		const results = await openMediaResults("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		const interaction = buttonInteraction(results, "Search Exactly as Entered");
		interaction.member = { user: { id: "other-user" } };
		const { response } = await dispatchInteraction(
			JSON.stringify(interaction),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(
			((await response.json()) as { data: { content: string } }).data.content,
		).toContain("someone else's");
	});

	it("renders a sanitized media-service error when details fail", async () => {
		const results = await openMediaResults("movie", "star wars", [
			{ id: 11, title: "Star Wars", release_date: "1977-05-25" },
		]);
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(500, "private provider body");
		const { captured } = interceptOriginalResponseEdit();
		const routed = await dispatchInteraction(
			JSON.stringify(selectInteraction(results)),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		await waitOnExecutionContext(routed.ctx);
		expect(JSON.stringify(captured)).not.toContain("private provider body");
	});
});
