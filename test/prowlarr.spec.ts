import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchProwlarr, sortResults } from "../src/services/prowlarr";
import {
	ConfigError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../src/utils/errors";
import type { TorrentResult } from "../src/types/search";
import {
	PROWLARR_EMPTY_JSON as EMPTY_JSON,
	PROWLARR_TWO_ITEM_JSON as TWO_ITEM_JSON,
} from "./fixtures";

const BASE_URL = "https://prowlarr.test";

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

function mockProwlarrReply(status: number, body: string) {
	return fetchMock
		.get(BASE_URL)
		.intercept({ path: /^\/api\/v1\/search/ })
		.reply(status, body, { headers: { "content-type": "application/json" } });
}

/** Read a header from whatever shape the mock interceptor passes along. */
function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	if (Array.isArray(headers)) {
		for (let i = 0; i + 1 < headers.length; i += 2) {
			if (String(headers[i]).toLowerCase() === name) {
				return String(headers[i + 1]);
			}
		}
		return undefined;
	}
	if (typeof headers === "object") {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === name) {
				return Array.isArray(value) ? String(value[0]) : String(value);
			}
		}
	}
	return undefined;
}

describe("searchProwlarr", () => {
	it("normalizes a successful search response", async () => {
		mockProwlarrReply(200, TWO_ITEM_JSON);

		const results = await searchProwlarr("blade runner", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});

		expect(results).toHaveLength(2);

		// Sorted by seeders: the 120-seed 1080p release ranks first.
		const hd = results[0];
		expect(hd.title).toContain("1080p");
		expect(hd.sizeBytes).toBe(1468006400);
		expect(hd.seeders).toBe(120);
		// peers = seeders + leechers (total swarm).
		expect(hd.peers).toBe(140);
		expect(hd.categoryId).toBe(2030);
		expect(hd.source).toBe("ExampleTracker");
		expect(hd.infoHash).toBe("89abcdef012345670123456789abcdef01234567");
		expect(hd.link).toBe("https://indexer.example/details/bbb");
		expect(hd.publishedAt).toBe("2025-02-02T08:30:00Z");

		const uhd = results[1];
		expect(uhd.title).toContain("2160p");
		expect(uhd.sizeBytes).toBe(26843545600);
		expect(uhd.seeders).toBe(34);
		expect(uhd.peers).toBe(40);
		expect(uhd.categoryId).toBe(2040);
		expect(uhd.publishedAt).toBe("2025-02-01T12:00:00Z");
	});

	it("never propagates Prowlarr's credential-bearing proxy URLs", async () => {
		mockProwlarrReply(200, TWO_ITEM_JSON);

		const results = await searchProwlarr("blade runner", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});

		for (const result of results) {
			// Magnets are synthesized from the info hash, never the proxy URL.
			expect(result.magnetUri).toMatch(/^magnet:\?xt=urn:btih:/);
			expect(result.magnetUri).toContain(result.infoHash as string);
			expect(result.link).not.toContain("apikey");
		}
		const serialized = JSON.stringify(results);
		expect(serialized).not.toContain("secret-prowlarr-key");
		expect(serialized).not.toContain("apikey=");
		expect(serialized).not.toContain("/download?");
	});

	it("passes through a raw magnet URI when Prowlarr reports one", async () => {
		mockProwlarrReply(
			200,
			JSON.stringify([
				{
					title: "Raw Magnet Release",
					magnetUrl: "magnet:?xt=urn:btih:89abcdef012345670123456789abcdef01234567&dn=raw",
					infoHash: "89abcdef012345670123456789abcdef01234567",
				},
			]),
		);

		const results = await searchProwlarr("x", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});
		expect(results[0].magnetUri).toBe(
			"magnet:?xt=urn:btih:89abcdef012345670123456789abcdef01234567&dn=raw",
		);
	});

	it("constructs the search URL with safely encoded query parameters", async () => {
		let seenPath: string | undefined;
		fetchMock
			.get(BASE_URL)
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((opts) => {
				seenPath = opts.path;
				return { statusCode: 200, data: EMPTY_JSON };
			});

		await searchProwlarr('blade "runner" & more', {
			apiKey: "test-key",
			baseUrl: BASE_URL,
			limit: 7,
		});

		expect(seenPath).toBeDefined();
		const url = new URL(`${BASE_URL}${seenPath}`);
		expect(url.pathname).toBe("/api/v1/search");
		expect(url.searchParams.get("query")).toBe('blade "runner" & more');
		expect(url.searchParams.get("type")).toBe("search");
		expect(url.searchParams.get("limit")).toBe("7");
	});

	it("sends the API key in the X-Api-Key header and never in the URL", async () => {
		let seenPath: string | undefined;
		let seenKey: string | undefined;
		fetchMock
			.get(BASE_URL)
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply((opts) => {
				seenPath = opts.path;
				seenKey = headerValue(opts.headers, "x-api-key");
				return { statusCode: 200, data: EMPTY_JSON };
			});

		await searchProwlarr("ubuntu", {
			apiKey: "key with space",
			baseUrl: BASE_URL,
		});

		expect(seenKey).toBe("key with space");
		expect(seenPath).not.toContain("key with space");
		expect(seenPath).not.toContain("apikey");
	});

	it("returns an empty array for an empty result set", async () => {
		mockProwlarrReply(200, EMPTY_JSON);
		const results = await searchProwlarr("nothing matches this", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});
		expect(results).toEqual([]);
	});

	it("tolerates releases missing all optional fields", async () => {
		mockProwlarrReply(200, JSON.stringify([{ title: "Only A Title" }]));
		const results = await searchProwlarr("x", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});
		expect(results).toEqual([
			{
				title: "Only A Title",
				sizeBytes: null,
				seeders: null,
				peers: null,
				categoryId: null,
				source: null,
				link: null,
				infoHash: null,
				magnetUri: null,
				publishedAt: null,
			},
		]);
	});

	it("skips entries that are not usable releases", async () => {
		mockProwlarrReply(
			200,
			JSON.stringify([
				null,
				42,
				"junk",
				{ indexer: "no-title-here" },
				{ title: "  " },
				{ title: "Real One" },
			]),
		);
		const results = await searchProwlarr("x", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
		});
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Real One");
	});

	it("throws UpstreamParseError for malformed JSON", async () => {
		mockProwlarrReply(200, "[{not json");
		await expect(
			searchProwlarr("x", { apiKey: "test-key", baseUrl: BASE_URL }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("throws UpstreamParseError for a valid but unexpected JSON shape", async () => {
		mockProwlarrReply(200, '{"results": []}');
		await expect(
			searchProwlarr("x", { apiKey: "test-key", baseUrl: BASE_URL }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("throws UpstreamStatusError for non-200 responses", async () => {
		mockProwlarrReply(500, "Internal Server Error");
		await expect(
			searchProwlarr("x", { apiKey: "test-key", baseUrl: BASE_URL }),
		).rejects.toMatchObject({ name: "UpstreamStatusError", status: 500 });

		// 401 is Prowlarr's response to a missing/invalid API key.
		mockProwlarrReply(401, "");
		await expect(
			searchProwlarr("x", { apiKey: "bad-key", baseUrl: BASE_URL }),
		).rejects.toBeInstanceOf(UpstreamStatusError);
	});

	it("never leaks the API key through error messages", async () => {
		mockProwlarrReply(403, "Forbidden");
		const failure = await searchProwlarr("x", {
			apiKey: "super-secret-key",
			baseUrl: BASE_URL,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UpstreamStatusError);
		expect((failure as Error).message).not.toContain("super-secret-key");
	});

	it("throws UpstreamTimeoutError when the upstream stalls", async () => {
		fetchMock
			.get(BASE_URL)
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(200, EMPTY_JSON)
			.delay(200);

		await expect(
			searchProwlarr("x", {
				apiKey: "test-key",
				baseUrl: BASE_URL,
				timeoutMs: 25,
			}),
		).rejects.toBeInstanceOf(UpstreamTimeoutError);
	});

	it("throws ConfigError for an invalid base URL", async () => {
		await expect(
			searchProwlarr("x", { apiKey: "test-key", baseUrl: "not a url" }),
		).rejects.toBeInstanceOf(ConfigError);
	});

	it("returns no more than the requested limit, sorted", async () => {
		mockProwlarrReply(200, TWO_ITEM_JSON);
		const results = await searchProwlarr("blade runner", {
			apiKey: "test-key",
			baseUrl: BASE_URL,
			limit: 1,
		});
		expect(results).toHaveLength(1);
		expect(results[0].seeders).toBe(120);
	});
});

describe("sortResults", () => {
	it("orders by seeders, then size, then title, deterministically", () => {
		const make = (partial: Partial<TorrentResult>): TorrentResult => ({
			title: "t",
			sizeBytes: null,
			seeders: null,
			peers: null,
			categoryId: null,
			source: null,
			link: null,
			infoHash: null,
			magnetUri: null,
			publishedAt: null,
			...partial,
		});
		const results = [
			make({ title: "c-title", seeders: 10 }),
			make({ title: "a-title", seeders: 10 }),
			make({ title: "b-title", seeders: 50, sizeBytes: 100 }),
			make({ title: "d-title", seeders: 50, sizeBytes: 200 }),
			make({ title: "e-title" }),
		];

		const sorted = sortResults(results);
		expect(sorted.map((r) => r.title)).toEqual([
			"d-title",
			"b-title",
			"a-title",
			"c-title",
			"e-title",
		]);
	});
});
