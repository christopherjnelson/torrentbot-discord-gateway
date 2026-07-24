import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	getTmdbDetails,
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
				}),
			);
		await expect(
			getTmdbDetails("tv", 2316, { readAccessToken: TOKEN }),
		).resolves.toMatchObject({
			title: "The Office",
			year: null,
			mediaType: "tv",
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
