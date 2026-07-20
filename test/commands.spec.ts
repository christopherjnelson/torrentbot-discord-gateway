import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeInteraction,
	TEST_INTERACTION_TOKEN,
	TEST_GUILD_ID,
	TEST_UNAUTHORIZED_GUILD_ID,
	TEST_USER_ID,
} from "./helpers";

const VALID_MAGNET =
	"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=blade";

const CREATE_OK = JSON.stringify({
	success: true,
	error: null,
	detail: "Torrent Added Successfully",
	data: { hash: "abc123hash", torrent_id: 42, auth_id: "auth-x" },
});

const MYLIST_OK = JSON.stringify({
	success: true,
	error: null,
	detail: "Torrent list retrieved successfully.",
	data: [
		{
			id: 42,
			hash: "abc123hash",
			name: "Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-GRP",
			size: 1468006400,
			active: true,
			created_at: "2026-03-08T21:21:28Z",
			updated_at: "2026-03-08T21:21:41Z",
			download_state: "downloading",
			seeds: 12,
			peers: 30,
			progress: 0.45,
			download_speed: 1024,
			upload_speed: 0,
			download_finished: false,
			cached: false,
			magnet: "magnet:?xt=urn:btih:secret",
			download_path: "/private/path",
		},
	],
});

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

describe("/add command", () => {
	it("rejects invalid magnet input ephemerally without upstream calls", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("add", [
					{ name: "magnet", type: 3, value: "https://example.com/x.torrent" },
				]),
			),
		);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("Invalid magnet URI");
	});

	it("rejects interactions from an unauthorized guild ephemerally without upstream calls", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction(
					"add",
					[{ name: "magnet", type: 3, value: VALID_MAGNET }],
					{ guild_id: TEST_UNAUTHORIZED_GUILD_ID },
				),
			),
		);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toBe(
			"TorrentBot is not enabled for this server.",
		);
	});

	it("defers ephemerally and reports the created torrent", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
			.reply(200, CREATE_OK);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("add", [
					{ name: "magnet", type: 3, value: VALID_MAGNET },
				]),
			),
		);

		expect(await response.json()).toEqual({
			type: 5,
			data: { flags: 64 },
		});

		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("Torrent added to TorBox");
		expect(content).toContain("`42`");
		// The full magnet must never be echoed back.
		expect(content).not.toContain("magnet:?xt");
		expect(captured[0].path).toContain(TEST_INTERACTION_TOKEN);
	});

	it("maps duplicate submissions to a friendly message", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
			.reply(
				400,
				JSON.stringify({
					success: false,
					error: "DUPLICATE_ITEM",
					detail: "This item already exists.",
					data: null,
				}),
			);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("add", [
					{ name: "magnet", type: 3, value: VALID_MAGNET },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("already on your TorBox account");
	});

	it("responds ephemerally when TorBox is not configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("add", [
					{ name: "magnet", type: 3, value: VALID_MAGNET },
				]),
			),
			{ TORBOX_API_KEY: "" },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toContain("not configured");
	});
});

describe("/status command", () => {
	it("rejects interactions from an unauthorized guild", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("status", [], {
					guild_id: TEST_UNAUTHORIZED_GUILD_ID,
				}),
			),
		);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toBe(
			"TorrentBot is not enabled for this server.",
		);
	});

	it("lists downloads without leaking private data", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, MYLIST_OK);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });

		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("TorBox downloads (1 total)");
		expect(content).toContain("Blade.Runner.1982");
		expect(content).toContain("1.4 GiB");
		expect(content).toContain("downloading");
		expect(content).toContain("45%");
		expect(content).toContain("12 seeds");
		// No private data may leak.
		expect(content).not.toContain("magnet:?xt");
		expect(content).not.toContain("/private/path");
		expect(content).not.toContain(TEST_USER_ID);
	});

	it("reports an empty account", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "ok",
					data: [],
				}),
			);
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("No downloads");
	});

	it("reports TorBox failures gracefully", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(500, "boom");
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("HTTP 500");
	});
});

describe("authorization edge cases", () => {
	it("rejects /status when invoked from a DM", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeInteraction({
					data: { name: "status" },
					member: undefined,
					user: { id: "someone-else" },
					guild_id: undefined,
				}),
			),
		);
		const body = (await response.json()) as {
			type: number;
			data: { flags?: number; content: string };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toBe(
			"TorrentBot can only be used in an authorized server.",
		);
	});

	it("rejects /add when invoked from a DM", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction(
					"add",
					[{ name: "magnet", type: 3, value: VALID_MAGNET }],
					{ member: undefined, user: { id: "someone-else" }, guild_id: undefined },
				),
			),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot can only be used in an authorized server.",
		);
	});

	it("rejects /search when invoked from a DM", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction(
					"search",
					[{ name: "query", type: 3, value: "blade runner" }],
					{ member: undefined, user: { id: "someone-else" }, guild_id: undefined },
				),
			),
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot can only be used in an authorized server.",
		);
	});

	it("rejects all commands when the guild allowlist is empty", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{ TORBOX_ALLOWED_GUILD_IDS: "" },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
	});

	it("rejects all commands when the guild allowlist is missing", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{ TORBOX_ALLOWED_GUILD_IDS: "" },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
	});

	it("fails closed when the guild allowlist is malformed", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{ TORBOX_ALLOWED_GUILD_IDS: "not-a-snowflake" },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
	});

	it("fails closed when any guild ID in the allowlist is malformed", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{ TORBOX_ALLOWED_GUILD_IDS: `${TEST_GUILD_ID},bad-id` },
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
	});

	it("no longer grants access via the previous user-ID variable", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{
				TORBOX_ALLOWED_GUILD_IDS: "",
				TORBOX_ALLOWED_USER_IDS: TEST_USER_ID,
			},
		);
		const body = (await response.json()) as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
	});

	it("accepts an authorized guild with multiple comma-separated IDs", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "ok",
					data: [],
				}),
			);
		const { captured } = interceptOriginalResponseEdit();
		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
			{
				TORBOX_ALLOWED_GUILD_IDS: `${TEST_UNAUTHORIZED_GUILD_ID}, ${TEST_GUILD_ID} `,
			},
		);
		await waitOnExecutionContext(ctx);
		expect(captured[0].body.content).toContain("No downloads");
	});
});
