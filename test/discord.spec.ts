import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { PROWLARR_EMPTY_JSON, PROWLARR_TWO_ITEM_JSON } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeInteraction,
	TEST_APPLICATION_ID,
	TEST_INTERACTION_TOKEN,
	TEST_GUILD_ID,
	TEST_UNAUTHORIZED_GUILD_ID,
} from "./helpers";
import { parseInteraction } from "../src/discord/types";

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

function mockProwlarr(status: number, body: string) {
	return fetchMock
		.get("https://prowlarr.test")
		.intercept({ path: /^\/api\/v1\/search/ })
		.reply(status, body, { headers: { "content-type": "application/json" } });
}

describe("signed interaction handling", () => {
	it("answers a valid PING with PONG", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeInteraction({ type: 1 })),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it("rejects structurally invalid interaction payloads", async () => {
		const { response } = await dispatchInteraction('{"type":1}');
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Invalid interaction payload",
		});
	});

	it("rejects invalid JSON bodies", async () => {
		const { response } = await dispatchInteraction("{not json");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Invalid JSON body",
		});
	});

	it("rejects unsupported interaction types", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeInteraction({ type: 99 })),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Unsupported interaction type",
		});
	});

	it("answers unknown commands with an ephemeral message", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("explode")),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("Unknown command");
	});
});

describe("guild_id parsing", () => {
	it("preserves a valid top-level guild_id", () => {
		const interaction = parseInteraction({
			id: "i1",
			application_id: "a1",
			type: 2,
			token: "t1",
			guild_id: TEST_GUILD_ID,
			data: { name: "search" },
		});
		expect(interaction).not.toBeNull();
		expect(interaction?.guild_id).toBe(TEST_GUILD_ID);
	});

	it("treats a missing guild_id as undefined (DM)", () => {
		const interaction = parseInteraction({
			id: "i1",
			application_id: "a1",
			type: 2,
			token: "t1",
			data: { name: "search" },
		});
		expect(interaction).not.toBeNull();
		expect(interaction?.guild_id).toBeUndefined();
	});

	it("rejects a non-string guild_id", () => {
		expect(
			parseInteraction({
				id: "i1",
				application_id: "a1",
				type: 2,
				token: "t1",
				guild_id: 12345,
			}),
		).toBeNull();
		expect(
			parseInteraction({
				id: "i1",
				application_id: "a1",
				type: 2,
				token: "t1",
				guild_id: null,
			}),
		).toBeNull();
	});

	it("does not fabricate a guild_id from nested data", () => {
		const interaction = parseInteraction({
			id: "i1",
			application_id: "a1",
			type: 2,
			token: "t1",
			data: { name: "search", guild_id: TEST_GUILD_ID },
		});
		expect(interaction).not.toBeNull();
		expect(interaction?.guild_id).toBeUndefined();
	});

	it("guild_id is preserved through routing to the search handler", async () => {
		mockProwlarr(200, PROWLARR_EMPTY_JSON);
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);
		expect(captured[0].body.content).toContain(
			"No results found for `blade runner`.",
		);
	});

	it("rejects /search from an unauthorized guild without contacting Prowlarr", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				], { guild_id: TEST_UNAUTHORIZED_GUILD_ID }),
			),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot is not enabled for this server.",
		);
	});
});

describe("/search command", () => {
	it("rejects the legacy flat query shape", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeInteraction({
					data: {
						name: "search",
						options: [
							{ name: "query", type: 3, value: "blade runner" },
						],
					},
				}),
			),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("Invalid search options");
	});

	it("rejects a missing query option without contacting upstreams", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("search")),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("query");
	});

	it.each([
		{
			label: "unknown subcommand",
			options: [
				{
					name: "unknown",
					type: 1,
					options: [{ name: "query", type: 3, value: "blade runner" }],
				},
			],
		},
		{
			label: "missing nested query",
			options: [{ name: "general", type: 1, options: [] }],
		},
		{
			label: "blank query",
			options: [
				{
					name: "general",
					type: 1,
					options: [{ name: "query", type: 3, value: "   " }],
				},
			],
		},
		{
			label: "duplicated subcommands",
			options: [
				{
					name: "general",
					type: 1,
					options: [{ name: "query", type: 3, value: "one" }],
				},
				{
					name: "movie",
					type: 1,
					options: [{ name: "query", type: 3, value: "two" }],
				},
			],
		},
		{
			label: "duplicated query options",
			options: [
				{
					name: "general",
					type: 1,
					options: [
						{ name: "query", type: 3, value: "one" },
						{ name: "query", type: 3, value: "two" },
					],
				},
			],
		},
		{
			label: "wrong nested option type",
			options: [
				{
					name: "general",
					type: 1,
					options: [{ name: "query", type: 4, value: "blade runner" }],
				},
			],
		},
	])("rejects $label", async ({ options }) => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("search", options)),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("Invalid search options");
	});

	it("rejects an over-length query", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "x".repeat(201) },
				]),
			),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("1-200 characters");
	});

	it("responds ephemerally when no Prowlarr API key is configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ PROWLARR_API_KEY: "" },
		);
		const body = (await response.json()) as {
			data: { flags?: number; content: string };
		};
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("not configured");
	});

	it("responds ephemerally when no Prowlarr URL is configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ PROWLARR_URL: "" },
		);
		const body = (await response.json()) as {
			data: { flags?: number; content: string };
		};
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("not configured");
	});

	it("defers, then edits the original response with formatted results", async () => {
		mockProwlarr(200, PROWLARR_TWO_ITEM_JSON);
		// Best-effort TorBox cache check: nothing cached (data: null), so no
		// badges are appended and the option descriptions stay unchanged.
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /\/v1\/api\/torrents\/checkcached/, method: "POST" })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "Torrent cache status retrieved successfully.",
					data: null,
				}),
			);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);

		// Initial response is an immediate defer inside the 3s deadline.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });

		await waitOnExecutionContext(ctx);

		expect(captured).toHaveLength(1);
		const edit = captured[0];
		// Correct follow-up endpoint: application id + interaction token.
		expect(edit.path).toBe(
			`/api/v10/webhooks/${TEST_APPLICATION_ID}/${TEST_INTERACTION_TOKEN}/messages/@original`,
		);
		expect(edit.body.allowed_mentions).toEqual({ parse: [] });

		const content = edit.body.content ?? "";
		// Concise heading only — no duplicated numbered result list.
		expect(content).toContain("Choose a release for **blade runner**:");
		expect(content).not.toContain("**1.** `Blade.Runner");
		expect(content).not.toContain("Top");
		expect(content.length).toBeLessThanOrEqual(2000);

		// A select menu is attached with descriptive options.
		const components = (edit.body as any).components as any[];
		expect(Array.isArray(components)).toBe(true);
		const select = components[0].components[0];
		expect(select.type).toBe(3);
		expect(select.placeholder).toBe("Select a release to download");
		expect(select.options.length).toBe(2);
		// The 120-seed 1080p release ranks first.
		expect(select.options[0].label).toContain("Blade.Runner.1982.Final.Cut.1080p");
		expect(select.options[0].description).toContain("1.4 GiB");
		expect(select.options[0].description).toContain("120 seeds");
		expect(select.options[0].description).toContain("ExampleTracker");
		// Hidden value is the info hash; never shown in content or label.
		expect(select.options[0].value).toBe("89abcdef012345670123456789abcdef01234567");
		expect(content).not.toContain(select.options[0].value);
		expect(select.options[0].label).not.toContain(select.options[0].value);
		expect(select.options[0].description).not.toContain(select.options[0].value);
		// Magnet URIs and Prowlarr proxy URLs (which embed the API key) must
		// never appear in Discord output.
		expect(content).not.toContain("magnet:?xt");
		expect(content).not.toContain("btih");
		expect(content).not.toContain("apikey");
		expect(content).not.toContain("prowlarr-key");
	});

	it("reports empty result sets", async () => {
		mockProwlarr(200, PROWLARR_EMPTY_JSON);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "nothing exists here" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toBe(
			"No results found for `nothing exists here`.",
		);
	});

	it("reports upstream HTTP failures gracefully", async () => {
		mockProwlarr(500, "boom");
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("HTTP 500");
	});

	it("reports invalid Prowlarr credentials gracefully", async () => {
		// Prowlarr answers a missing/invalid API key with 401.
		mockProwlarr(401, "");
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("rejected the configured credentials");
	});

	it("reports upstream timeouts", async () => {
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(200, PROWLARR_EMPTY_JSON)
			.delay(200);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ UPSTREAM_TIMEOUT_MS: "25" },
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("timed out");
	});

	it("reports malformed upstream JSON gracefully", async () => {
		mockProwlarr(200, "[{not json");
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("unexpected response");
	});
});

/** Intercept one POST /torrents/checkcached call, optionally counting. */
function interceptCheckCached(
	replyStatus: number,
	replyBody: string,
): { calls: () => number } {
	let calls = 0;
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: /\/v1\/api\/torrents\/checkcached/, method: "POST" })
		.reply((opts) => {
			calls++;
			return { statusCode: replyStatus, data: replyBody };
		});
	return { calls: () => calls };
}

const CHECKCACHED_UNCACHED = JSON.stringify({
	success: true,
	error: null,
	detail: "Torrent cache status retrieved successfully.",
	data: null,
});

/** Prowlarr fixture with three valid-hash results and one invalid-hash row. */
const PROWLARR_CACHE_JSON = JSON.stringify([
	{
		title: "Cached.Release.1080p",
		size: 2147483648,
		seeders: 7049,
		leechers: 6,
		indexer: "The Pirate Bay",
		infoUrl: "https://indexer.example/details/aaa",
		infoHash: "0123456789abcdef0123456789abcdef01234567",
		categories: [{ id: 2040, name: "Movies HD" }],
	},
	{
		title: "Uncached.Release.1080p",
		size: 1468006400,
		seeders: 120,
		leechers: 20,
		indexer: "ExampleTracker",
		infoUrl: "https://indexer.example/details/bbb",
		infoHash: "89abcdef012345670123456789abcdef01234567",
		categories: [{ id: 2030, name: "Movies HD" }],
	},
	{
		title: "Unknown.Release.1080p",
		size: 734003200,
		seeders: 12,
		leechers: 3,
		indexer: "OtherTracker",
		infoUrl: "https://indexer.example/details/ccc",
		infoHash: "fedcba9876543210fedcba9876543210fedcba98",
		categories: [{ id: 2030, name: "Movies HD" }],
	},
	{
		// No info hash -> excluded from the select menu and the cache check.
		title: "Hashless.Release",
		size: 1000,
		seeders: 1,
		leechers: 0,
		indexer: "NoHashTracker",
		infoUrl: "https://indexer.example/details/none",
		infoHash: "short",
		categories: [{ id: 2030, name: "Movies HD" }],
	},
]);

describe("/search TorBox cache enrichment", () => {
	function selectOptions(captured: { body: { components?: any[] } }[]): any[] {
		const edit = captured[0];
		const components = (edit.body as any).components as any[];
		const select = components[0].components[0];
		return select.options;
	}

	it("appends the cache badge to a cached result and omits it elsewhere", async () => {
		mockProwlarr(200, PROWLARR_CACHE_JSON);
		interceptCheckCached(
			200,
			JSON.stringify({
				success: true,
				error: null,
				detail: "Torrent cache status retrieved successfully.",
				data: {
					// Only the first (cached) hash is present.
					"0123456789abcdef0123456789abcdef01234567": {
						name: "n",
						size: 1,
						hash: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			}),
		);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const options = selectOptions(captured);
		// Deterministic order: seeders desc -> cached result ranks first.
		expect(options[0].label).toBe("Cached.Release.1080p");
		expect(options[0].description).toContain("⚡ Cached");
		expect(options[0].description).toContain("2 GiB");
		expect(options[0].description).toContain("7049 seeds");
		expect(options[0].description).toContain("The Pirate Bay");

		// Uncached and unknown results get no cache wording.
		for (const opt of options.slice(1)) {
			expect(opt.description).not.toContain("Cached");
			expect(opt.description).not.toContain("⚡");
		}

		// The invalid-hash row is excluded from the select menu entirely.
		expect(options.map((o: any) => o.label)).not.toContain("Hashless.Release");
	});

	it("matches cached status by normalized hash (uppercase Prowlarr hash)", async () => {
		mockProwlarr(
			200,
			JSON.stringify([
				{
					title: "Up.Hash.Release",
					size: 1468006400,
					seeders: 100,
					leechers: 0,
					indexer: "Tracker",
					infoUrl: "https://indexer.example/details/u",
					infoHash: "0123456789ABCDEF0123456789ABCDEF01234567",
					categories: [{ id: 2040, name: "Movies HD" }],
				},
			]),
		);
		interceptCheckCached(
			200,
			JSON.stringify({
				success: true,
				error: null,
				detail: "Torrent cache status retrieved successfully.",
				data: {
					"0123456789abcdef0123456789abcdef01234567": {
						name: "n",
						size: 1,
						hash: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			}),
		);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "x" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const options = selectOptions(captured);
		expect(options[0].description).toContain("⚡ Cached");
	});

	it("makes exactly one cache request for up to ten results", async () => {
		mockProwlarr(200, PROWLARR_CACHE_JSON);
		const check = interceptCheckCached(200, CHECKCACHED_UNCACHED);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		expect(check.calls()).toBe(1);
		// Sanity: the select menu has the three valid-hash results.
		expect(selectOptions(captured)).toHaveLength(3);
	});

	it("shows up to 10 distinct valid releases with one cache request", async () => {
		// 10 valid distinct-hash releases + 1 duplicate + 1 invalid-hash.
		const HASHES = Array.from({ length: 10 }, (_, i) =>
			(i.toString(16) + "0".repeat(39)).slice(0, 40),
		);
		const tenItems = HASHES.map((h, i) => ({
			title: `Release.${i + 1}`,
			size: 1000000 * (i + 1),
			seeders: 100 - i,
			leechers: 5,
			indexer: "Tracker",
			infoUrl: `https://indexer.example/details/${i}`,
			infoHash: h,
			categories: [{ id: 2040, name: "Movies HD" }],
		}));
		// A duplicate of the first hash (by uppercase) — must not add an option.
		tenItems.push({
			...tenItems[0],
			title: "Duplicate.Release",
			infoHash: HASHES[0].toUpperCase(),
		});
		// An invalid-hash entry — must not be selectable.
		tenItems.push({
			title: "Hashless.Release",
			size: 1,
			seeders: 1,
			leechers: 0,
			indexer: "NoHash",
			infoUrl: "https://indexer.example/details/none",
			infoHash: "short",
			categories: [{ id: 2040, name: "Movies HD" }],
		});
		mockProwlarr(200, JSON.stringify(tenItems));
		let cacheBody: unknown;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /\/v1\/api\/torrents\/checkcached/, method: "POST" })
			.reply((opts) => {
				cacheBody = JSON.parse(String(opts.body));
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, error: null, detail: "ok", data: null }),
				};
			});
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "test" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const options = selectOptions(captured);
		expect(options).toHaveLength(10);
		// No more than 10 options.
		expect(options.length).toBeLessThanOrEqual(10);
		// Exactly one cache request for all 10 selectable hashes.
		const hashes = (cacheBody as { hashes: string[] }).hashes;
		expect(hashes).toHaveLength(10);
		// The cache request includes the same normalized (lowercase) hashes.
		const optionValues = options.map((o: { value: string }) => o.value.toLowerCase());
		expect(hashes.sort()).toEqual([...optionValues].sort());
		// Dedup: all option values are distinct (the duplicate hash appears once).
		expect(new Set(optionValues).size).toBe(optionValues.length);
		// The invalid-hash entry is not in the menu.
		expect(options.map((o: { label: string }) => o.label)).not.toContain("Hashless.Release");
	});

	it("still returns search results when the cache check fails", async () => {
		mockProwlarr(200, PROWLARR_CACHE_JSON);
		interceptCheckCached(500, "boom");
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("Choose a release for **blade runner**:");
		const options = selectOptions(captured);
		expect(options).toHaveLength(3);
		// No badges when the cache check failed.
		for (const opt of options) {
			expect(opt.description ?? "").not.toContain("Cached");
		}
	});

	it("skips the cache check when TorBox is not configured", async () => {
		mockProwlarr(200, PROWLARR_CACHE_JSON);
		// No checkcached interceptor: if a request were made it would throw
		// and the /search results would still come back without badges.
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{
				COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!",
				TORBOX_API_KEY: "",
			},
		);
		await waitOnExecutionContext(ctx);

		const options = selectOptions(captured);
		expect(options).toHaveLength(3);
		for (const opt of options) {
			expect(opt.description ?? "").not.toContain("Cached");
		}
	});

	it("never shows hashes, magnets, or badges-in-content in visible output", async () => {
		mockProwlarr(200, PROWLARR_CACHE_JSON);
		interceptCheckCached(
			200,
			JSON.stringify({
				success: true,
				error: null,
				detail: "ok",
				data: {
					"0123456789abcdef0123456789abcdef01234567": {
						name: "n",
						size: 1,
						hash: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			}),
		);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const edit = captured[0];
		const content = edit.body.content ?? "";
		const options = selectOptions(captured);
		const visible = `${content} ${JSON.stringify(options)}`;

		expect(content).not.toContain("magnet:?xt");
		expect(content).not.toContain("btih");
		for (const opt of options) {
			// No hash in label or description.
			expect(opt.label).not.toMatch(/[0-9a-f]{40}/i);
			expect(opt.description ?? "").not.toMatch(/[0-9a-f]{40}/i);
			// No "Not cached" wording.
			expect(opt.description ?? "").not.toContain("Not cached");
		}
		// The badge only ever appears inside option descriptions.
		expect(visible).toContain("⚡ Cached");
	});

	it("does not crash the Worker when the final /search edit is rejected", async () => {
		mockProwlarr(200, PROWLARR_TWO_ITEM_JSON);
		// Best-effort cache check: nothing cached.
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /\/v1\/api\/torrents\/checkcached/, method: "POST" })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "Torrent cache status retrieved successfully.",
					data: null,
				}),
			);
		// The final editOriginalResponse is rejected by Discord (400).
		fetchMock
			.get("https://discord.com")
			.intercept({
				path: (p) =>
					p.includes("/webhooks/") && p.endsWith("/messages/@original"),
				method: "PATCH",
			})
			.reply(
				400,
				JSON.stringify({
					code: 50035,
					message: "Invalid Form Body",
					errors: {
						data: {
							components: {
								"0": {
									components: {
										"0": {
											options: {
												"0": {
													value: {
														_errors: [
															{
																code: "BASE_TYPE_MAX_LENGTH",
																message:
																	"Must be 100 or fewer in length.",
															},
														],
													},
												},
											},
										},
									},
								},
							},
						},
					},
				}),
			);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const { ctx, response } = await dispatchInteraction(
				JSON.stringify(
					makeCommandInteraction("search", [
						{ name: "query", type: 3, value: "grogu" },
					]),
				),
				{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
			);

			// The initial defer still succeeds (HTTP 200, type 5).
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				type: 5,
				data: { flags: 64 },
			});

			// The background phase must not throw or reject the Worker.
			await waitOnExecutionContext(ctx);

			// The structured Discord diagnostics are logged exactly once.
			expect(warnSpy.mock.calls).toHaveLength(1);
			const [context, diag] = warnSpy.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(context).toBe("failed to edit interaction response");
			expect(diag).toMatchObject({ status: 400, code: 50035 });
			expect(Array.isArray(diag.fieldErrors)).toBe(true);

			// No secrets leak into the logs.
			const logged = JSON.stringify(warnSpy.mock.calls);
			expect(logged).not.toContain(TEST_INTERACTION_TOKEN);
			expect(logged).not.toContain("magnet:?xt");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("keeps option descriptions within Discord's 100-char limit", async () => {
		mockProwlarr(
			200,
			JSON.stringify([
				{
					title: "Cached.Release.With.A.Very.Long.Source.Name.That.Could.Overflow.The.Description.Limit.When.Joined",
					size: 2147483648,
					seeders: 7049,
					leechers: 6,
					indexer: "Extremely Long Indexer Display Name That Eats Description Budget",
					infoUrl: "https://indexer.example/details/aaa",
					infoHash: "0123456789abcdef0123456789abcdef01234567",
					categories: [{ id: 2040, name: "Movies HD" }],
				},
			]),
		);
		interceptCheckCached(
			200,
			JSON.stringify({
				success: true,
				error: null,
				detail: "ok",
				data: {
					"0123456789abcdef0123456789abcdef01234567": {
						name: "n",
						size: 1,
						hash: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			}),
		);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: "test-signing-secret-32-bytes-long!" },
		);
		await waitOnExecutionContext(ctx);

		const options = selectOptions(captured);
		for (const opt of options) {
			expect((opt.description ?? "").length).toBeLessThanOrEqual(100);
		}
	});
});
