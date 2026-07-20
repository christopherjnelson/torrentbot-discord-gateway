import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	parseTorznabXml,
	searchTorrents,
	sortResults,
} from "../src/services/voyager";
import {
	TorznabResponseError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../src/utils/errors";
import type { TorrentResult } from "../src/types/torznab";
import {
	TORZNAB_EMPTY_XML as EMPTY_XML,
	TORZNAB_ERROR_XML as ERROR_XML,
	TORZNAB_TWO_ITEM_XML as TWO_ITEM_XML,
} from "./fixtures";

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

function mockVoyagerReply(status: number, body: string) {
	return fetchMock
		.get("https://search-api.torbox.app")
		.intercept({ path: /^\/torznab\/api/ })
		.reply(status, body, { headers: { "content-type": "application/xml" } });
}

describe("searchTorrents", () => {
	it("normalizes a successful torznab response", async () => {
		mockVoyagerReply(200, TWO_ITEM_XML);

		const results = await searchTorrents("blade runner", {
			apiKey: "test-key",
		});

		expect(results).toHaveLength(2);

		const uhd = results.find((r) => r.title.includes("2160p"));
		expect(uhd).toBeDefined();
		expect(uhd?.sizeBytes).toBe(26843545600);
		expect(uhd?.seeders).toBe(34);
		expect(uhd?.peers).toBe(40);
		expect(uhd?.categoryId).toBe(2040);
		expect(uhd?.source).toBe("ExampleTracker");
		expect(uhd?.infoHash).toBe(
			"0123456789ABCDEF0123456789ABCDEF01234567",
		);
		expect(uhd?.magnetUri).toContain("magnet:?xt=urn:btih:0123");
		expect(uhd?.link).toBe("https://indexer.example/download/aaa");
		expect(uhd?.publishedAt).toBe("Sat, 01 Feb 2025 12:00:00 +0000");

		// Magnet URI recovered from a magnet: link when no magneturl attr exists.
		const hd = results.find((r) => r.title.includes("1080p"));
		expect(hd?.magnetUri).toBe(
			"magnet:?xt=urn:btih:89abcdef012345670123456789abcdef01234567",
		);
		expect(hd?.sizeBytes).toBe(1468006400);
	});

	it("sends the required torznab query parameters", async () => {
		let seenPath: string | undefined;
		fetchMock
			.get("https://search-api.torbox.app")
			.intercept({ path: /^\/torznab\/api/ })
			.reply((opts) => {
				seenPath = opts.path;
				return { statusCode: 200, data: EMPTY_XML };
			});

		await searchTorrents('blade "runner" & more', { apiKey: "key with space" });

		expect(seenPath).toBeDefined();
		const url = new URL(`https://search-api.torbox.app${seenPath}`);
		expect(url.searchParams.get("t")).toBe("search");
		expect(url.searchParams.get("q")).toBe('blade "runner" & more');
		expect(url.searchParams.get("o")).toBe("xml");
		expect(url.searchParams.get("apikey")).toBe("key with space");
	});

	it("returns an empty array for an empty result set", async () => {
		mockVoyagerReply(200, EMPTY_XML);
		const results = await searchTorrents("nothing matches this", {
			apiKey: "test-key",
		});
		expect(results).toEqual([]);
	});

	it("throws UpstreamStatusError for non-200 responses", async () => {
		mockVoyagerReply(500, "Internal Server Error");
		await expect(
			searchTorrents("x", { apiKey: "test-key" }),
		).rejects.toBeInstanceOf(UpstreamStatusError);

		mockVoyagerReply(500, "Internal Server Error");
		await expect(
			searchTorrents("x", { apiKey: "test-key" }),
		).rejects.toMatchObject({ status: 500 });
	});

	it("surfaces the verified 429 invalid-key behavior", async () => {
		mockVoyagerReply(429, '{"error":"Rate limit exceeded: 0 per 1 minute"}');
		await expect(
			searchTorrents("x", { apiKey: "bad-key" }),
		).rejects.toMatchObject({ status: 429 });
	});

	it("throws UpstreamTimeoutError when the upstream stalls", async () => {
		fetchMock
			.get("https://search-api.torbox.app")
			.intercept({ path: /^\/torznab\/api/ })
			.reply(200, EMPTY_XML)
			.delay(200);

		await expect(
			searchTorrents("x", { apiKey: "test-key", timeoutMs: 25 }),
		).rejects.toBeInstanceOf(UpstreamTimeoutError);
	});

	it("throws UpstreamParseError for malformed XML", async () => {
		mockVoyagerReply(200, "<rss><channel><title>oops");
		await expect(
			searchTorrents("x", { apiKey: "test-key" }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("throws UpstreamParseError for unexpected but well-formed XML", async () => {
		mockVoyagerReply(200, "<something><else/></something>");
		await expect(
			searchTorrents("x", { apiKey: "test-key" }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("throws TorznabResponseError for protocol-level error documents", async () => {
		mockVoyagerReply(200, ERROR_XML);
		await expect(
			searchTorrents("x", { apiKey: "test-key" }),
		).rejects.toBeInstanceOf(TorznabResponseError);
	});
});

describe("parseTorznabXml", () => {
	it("tolerates items missing all optional fields", () => {
		const xml = `<?xml version="1.0"?>
		<rss version="2.0"><channel>
			<item><title>Only A Title</title></item>
		</channel></rss>`;
		expect(parseTorznabXml(xml)).toEqual([
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

	it("skips items without titles", () => {
		const xml = `<?xml version="1.0"?>
		<rss version="2.0"><channel>
			<item><link>https://example.com/x</link></item>
			<item><title>Real One</title></item>
		</channel></rss>`;
		const results = parseTorznabXml(xml);
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Real One");
	});

	it("rejects documents with DOCTYPE entity definitions (XXE/billion laughs)", () => {
		const xml = `<?xml version="1.0"?>
		<!DOCTYPE lolz [<!ENTITY lol "lollollollollollollollollollol">]>
		<rss version="2.0"><channel>
			<item><title>&lol;</title></item>
		</channel></rss>`;
		expect(() => parseTorznabXml(xml)).toThrow(UpstreamParseError);
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
