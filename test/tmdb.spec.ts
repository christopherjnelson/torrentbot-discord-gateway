import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	getTmdbDetails,
	normalizeTvSeasons,
	searchTmdb,
	TMDB_SEARCH_RESULT_CAP,
} from "../src/services/tmdb";
import {
	UpstreamNetworkError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../src/utils/errors";

const TOKEN = "synthetic-tmdb-token";

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

describe("TMDB search client", () => {
	it("searches movies with Bearer authentication and no token in the URL", async () => {
		let requestUrl = "";
		let authorization: string | undefined;
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: /^\/3\/search\/movie\?/ })
			.reply((options) => {
				requestUrl = String(options.path);
				authorization = (options.headers as Record<string, string>)
					.authorization;
				return {
					statusCode: 200,
					data: JSON.stringify({
						results: [
							{
								id: 11,
								title: "Star Wars",
								original_title: "Star Wars",
								release_date: "1977-05-25",
								popularity: 99.5,
							},
						],
					}),
				};
			});

		const results = await searchTmdb("movie", "star wars", {
			readAccessToken: TOKEN,
		});
		expect(authorization).toBe(`Bearer ${TOKEN}`);
		expect(requestUrl).toContain("query=star+wars");
		expect(requestUrl).toContain("include_adult=false");
		expect(requestUrl).not.toContain(TOKEN);
		expect(results).toEqual([
			{
				id: 11,
				mediaType: "movie",
				title: "Star Wars",
				originalTitle: "Star Wars",
				year: 1977,
				popularity: 99.5,
			},
		]);
	});

	it("uses TV fields and never substitutes movie fields", async () => {
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
							original_name: "Breaking Bad",
							first_air_date: "2008-01-20",
							title: "Wrong Movie Title",
							release_date: "1999-01-01",
						},
					],
				}),
			);
		const [result] = await searchTmdb("tv", "breaking bad", {
			readAccessToken: TOKEN,
		});
		expect(result.title).toBe("Breaking Bad");
		expect(result.originalTitle).toBe("Breaking Bad");
		expect(result.year).toBe(2008);
		expect(result.mediaType).toBe("tv");
	});

	it("drops missing titles, removes duplicate IDs, degrades bad dates, and caps results", async () => {
		const entries = [
			{ id: 1, title: "", release_date: "2020-01-01" },
			{ id: 2, title: "Bad Date", release_date: "2020-99-99" },
			{ id: 2, title: "Duplicate", release_date: "2021-01-01" },
			...Array.from({ length: 20 }, (_, index) => ({
				id: index + 3,
				title: `Movie ${index}`,
				release_date: null,
			})),
		];
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: /^\/3\/search\/movie\?/ })
			.reply(200, JSON.stringify({ results: entries }));
		const results = await searchTmdb("movie", "movies", {
			readAccessToken: TOKEN,
		});
		expect(results).toHaveLength(TMDB_SEARCH_RESULT_CAP);
		expect(results[0]).toMatchObject({ id: 2, title: "Bad Date", year: null });
		expect(results.filter((result) => result.id === 2)).toHaveLength(1);
	});

	it.each([
		["non-array results", JSON.stringify({ results: {} })],
		["missing results", JSON.stringify({ page: 1 })],
		["malformed JSON", "{broken"],
	])("rejects %s", async (_label, body) => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: /^\/3\/search\/movie\?/ })
			.reply(200, body);
		await expect(
			searchTmdb("movie", "query", { readAccessToken: TOKEN }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it.each([401, 429, 500])("normalizes HTTP %s without response bodies", async (status) => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: /^\/3\/search\/movie\?/ })
			.reply(status, "credential-or-provider-body");
		const error = await searchTmdb("movie", "query", {
			readAccessToken: TOKEN,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(UpstreamStatusError);
		expect((error as Error).message).not.toContain("credential");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	it("normalizes timeouts", async () => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: /^\/3\/search\/movie\?/ })
			.reply(200, JSON.stringify({ results: [] }))
			.delay(100);
		await expect(
			searchTmdb("movie", "query", {
				readAccessToken: TOKEN,
				timeoutMs: 10,
			}),
		).rejects.toBeInstanceOf(UpstreamTimeoutError);
	});

	it("normalizes network failures", async () => {
		await expect(
			searchTmdb("movie", "no interceptor", {
				readAccessToken: TOKEN,
			}),
		).rejects.toBeInstanceOf(UpstreamNetworkError);
	});
});

describe("TMDB details client", () => {
	it("fetches a movie by numeric ID and normalizes canonical metadata", async () => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(
				200,
				JSON.stringify({
					id: 11,
					title: "Star Wars",
					original_title: "Star Wars",
					release_date: "1977-05-25",
				}),
			);
		await expect(
			getTmdbDetails("movie", 11, { readAccessToken: TOKEN }),
		).resolves.toMatchObject({
			id: 11,
			title: "Star Wars",
			year: 1977,
			mediaType: "movie",
		});
	});

	it("fetches TV details and handles a missing first-air year", async () => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/tv/2316" })
			.reply(
				200,
				JSON.stringify({
					id: 2316,
					name: "The Office",
					original_name: "The Office",
					first_air_date: "",
					seasons: [
						{
							season_number: 1,
							episode_count: 6,
							name: "Season 1",
							air_date: "2005-03-24",
						},
					],
				}),
			);
		await expect(
			getTmdbDetails("tv", 2316, { readAccessToken: TOKEN }),
		).resolves.toMatchObject({
			title: "The Office",
			year: null,
			mediaType: "tv",
			seasons: [{ seasonNumber: 1, episodeCount: 6 }],
		});
	});

	it("normalizes only bounded card metadata and rejects arbitrary poster URLs", async () => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(
				200,
				JSON.stringify({
					id: 11,
					title: "Star Wars",
					release_date: "1977-05-25",
					overview: "A hero\nsets out.",
					poster_path: "https://attacker.example/poster.jpg",
					genres: [
						{ name: "Adventure" },
						{ name: "Adventure" },
						{ name: "Science Fiction" },
					],
					runtime: 121,
					status: "Released",
				}),
			);
		await expect(
			getTmdbDetails("movie", 11, { readAccessToken: TOKEN }),
		).resolves.toMatchObject({
			overview: "A hero sets out.",
			posterPath: null,
			genres: ["Adventure", "Science Fiction"],
			runtimeMinutes: 121,
			episodeRunTimeMinutes: null,
			status: "Released",
		});
	});

	it("rejects details whose returned ID does not match", async () => {
		fetchMock
			.get("https://api.themoviedb.org")
			.intercept({ path: "/3/movie/11" })
			.reply(200, JSON.stringify({ id: 12, title: "Wrong record" }));
		await expect(
			getTmdbDetails("movie", 11, { readAccessToken: TOKEN }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});
});

describe("TMDB TV season normalization", () => {
	it("normalizes, deduplicates, and numerically sorts valid season summaries", () => {
		expect(
			normalizeTvSeasons([
				{
					season_number: 10,
					episode_count: 12,
					name: "Season 10",
					air_date: "2020-01-01",
				},
				{
					season_number: 0,
					episode_count: 5,
					name: "Specials",
					air_date: null,
				},
				{ season_number: -1, episode_count: 1 },
				{ season_number: 1.5, episode_count: 2 },
				{ season_number: Number.POSITIVE_INFINITY, episode_count: 3 },
				{ season_number: 2, episode_count: null },
				{ season_number: 2, episode_count: 99 },
				{ season_number: 1 },
				null,
				"malformed",
			]),
		).toEqual([
			{ seasonNumber: 0, episodeCount: 5 },
			{ seasonNumber: 1, episodeCount: null },
			{ seasonNumber: 2, episodeCount: null },
			{ seasonNumber: 10, episodeCount: 12 },
		]);
	});

	it.each([undefined, null, {}, "seasons"])(
		"degrades a non-array seasons field to an empty list",
		(value) => {
			expect(normalizeTvSeasons(value)).toEqual([]);
		},
	);

	it("does not require season names, dates, or episode counts", () => {
		expect(
			normalizeTvSeasons([
				{ season_number: 3 },
				{
					season_number: 4,
					name: { untrusted: true },
					air_date: 42,
					episode_count: -1,
				},
			]),
		).toEqual([
			{ seasonNumber: 3, episodeCount: null },
			{ seasonNumber: 4, episodeCount: null },
		]);
	});
});
