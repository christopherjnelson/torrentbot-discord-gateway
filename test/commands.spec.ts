import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("does not request a download link for a processing torrent", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, MYLIST_OK);
		// No requestdl interceptor: if a request were made it would throw.
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("Blade.Runner.1982");
		expect(content).not.toContain("[Download]");
		expect(content).not.toContain("http");
	});

	it("shows a direct download link for a ready single-file torrent", async () => {
		const DOWNLOAD_URL =
			"https://tb-cdn.example/dld/11111111-2222-3333-4444-555555555555?token=x";
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 42, hash: "abc123hash", name: "Ready.Movie.2026.1080p",
							size: 1468006400, active: false,
							created_at: "2026-07-20T00:00:00Z",
							updated_at: "2026-07-20T00:00:10Z",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "Ready.Movie.2026.1080p.mkv", size: 1468006400 }],
						},
					],
				}),
			);
		let dlParams: URLSearchParams | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply((opts) => {
				dlParams = new URL(`https://api.torbox.app${opts.path}`).searchParams;
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, error: null, detail: "ok", data: DOWNLOAD_URL }),
				};
			});
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("Ready.Movie.2026.1080p");
		expect(content).toContain(`[Download](${DOWNLOAD_URL})`);
		// Single-file: requests file_id, not zip_link.
		expect(dlParams?.get("file_id")).toBe("0");
		expect(dlParams?.get("zip_link")).toBeNull();
		expect(dlParams?.get("torrent_id")).toBe("42");
		expect(captured[0].body.allowed_mentions).toEqual({ parse: [] });
	});

	it("shows a ZIP download link for a ready multi-file torrent", async () => {
		const DOWNLOAD_URL =
			"https://tb-cdn.example/zip/22222222-3333-4444-5555-666666666666?token=x";
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 77, hash: "def456hash", name: "Ready.Show.S01.2026",
							size: 5368709120, active: false,
							created_at: "2026-07-20T00:00:00Z",
							updated_at: "2026-07-20T00:00:10Z",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [
								{ id: 0, name: "ep01.mkv", size: 1073741824 },
								{ id: 1, name: "ep02.mkv", size: 1073741824 },
								{ id: 2, name: "ep03.mkv", size: 1073741824 },
							],
						},
					],
				}),
			);
		let dlParams: URLSearchParams | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply((opts) => {
				dlParams = new URL(`https://api.torbox.app${opts.path}`).searchParams;
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, error: null, detail: "ok", data: DOWNLOAD_URL }),
				};
			});
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		expect(content).toContain("Ready.Show.S01.2026");
		expect(content).toContain(`[Download](${DOWNLOAD_URL})`);
		// Multi-file: requests zip_link, not file_id.
		expect(dlParams?.get("zip_link")).toBe("true");
		expect(dlParams?.get("file_id")).toBeNull();
	});

	it("shows links for ready and status-only for processing in mixed results", async () => {
		const DOWNLOAD_URL =
			"https://tb-cdn.example/dld/33333333-4444-5555-6666-777777777777?token=x";
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 10, hash: "h10", name: "Processing.Torrent",
							size: 1073741824, active: true,
							created_at: "2026-07-20T00:00:00Z",
							updated_at: "2026-07-20T00:00:10Z",
							download_state: "downloading", seeds: 5, peers: 10, progress: 0.5,
							download_speed: 1024, upload_speed: 0,
							download_finished: false, download_present: false, cached: false,
							files: [],
						},
						{
							id: 20, hash: "h20", name: "Ready.Torrent",
							size: 524288000, active: false,
							created_at: "2026-07-20T00:00:00Z",
							updated_at: "2026-07-20T00:00:10Z",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "file.mkv", size: 524288000 }],
						},
					],
				}),
			);
		let dlCalls = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(() => {
				dlCalls++;
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, error: null, detail: "ok", data: DOWNLOAD_URL }),
				};
			});
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		const content = captured[0].body.content ?? "";
		// Only the ready torrent got a requestdl call.
		expect(dlCalls).toBe(1);
		expect(content).toContain("Processing.Torrent");
		expect(content).toContain("Ready.Torrent");
		expect(content).toContain(`[Download](${DOWNLOAD_URL})`);
	});

	it("omits a link and continues when one ready torrent's link request fails", async () => {
		const GOOD_URL =
			"https://tb-cdn.example/dld/44444444-5555-6666-7777-888888888888?token=x";
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 1, hash: "h1", name: "Fails.Link", size: 1000000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "f.mkv", size: 1000000 }],
						},
						{
							id: 2, hash: "h2", name: "Succeeds.Link", size: 2000000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "s.mkv", size: 2000000 }],
						},
					],
				}),
			);
		let dlCount = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(() => {
				dlCount++;
				if (dlCount === 1) {
					return { statusCode: 500, data: "boom" };
				}
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, error: null, detail: "ok", data: GOOD_URL }),
				};
			})
			.times(2);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { captured } = interceptOriginalResponseEdit();

		try {
			const { ctx } = await dispatchInteraction(
				JSON.stringify(makeCommandInteraction("status")),
			);
			await waitOnExecutionContext(ctx);

			const content = captured[0].body.content ?? "";
			expect(content).toContain("Fails.Link");
			expect(content).toContain("Succeeds.Link");
			expect(content).not.toContain("http://");
			expect(content).toContain(`[Download](${GOOD_URL})`);
			expect(dlCount).toBe(2);
			const logged = JSON.stringify(warnSpy.mock.calls);
			expect(logged).toContain("status download link failed");
			expect(logged).not.toContain(GOOD_URL);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("omits a non-HTTPS download URL safely", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 1, hash: "h1", name: "Insecure.Torrent", size: 1000000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "f.mkv", size: 1000000 }],
						},
					],
				}),
			);
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: "http://insecure.example/dld/should-be-rejected",
				}),
			);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { captured } = interceptOriginalResponseEdit();

		try {
			const { ctx } = await dispatchInteraction(
				JSON.stringify(makeCommandInteraction("status")),
			);
			await waitOnExecutionContext(ctx);

			const content = captured[0].body.content ?? "";
			expect(content).toContain("Insecure.Torrent");
			expect(content).not.toContain("[Download]");
			expect(content).not.toContain("http://insecure");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not log generated download URLs", async () => {
		const DOWNLOAD_URL =
			"https://tb-cdn.example/dld/55555555-6666-7777-8888-999999999999?token=secret";
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 1, hash: "h1", name: "Logged.Torrent", size: 1000000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "f.mkv", size: 1000000 }],
						},
					],
				}),
			);
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				200,
				JSON.stringify({ success: true, error: null, detail: "ok", data: DOWNLOAD_URL }),
			);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { captured } = interceptOriginalResponseEdit();

		try {
			const { ctx } = await dispatchInteraction(
				JSON.stringify(makeCommandInteraction("status")),
			);
			await waitOnExecutionContext(ctx);

			// The URL appears in the ephemeral Discord content but is never logged.
			const content = captured[0].body.content ?? "";
			expect(content).toContain(DOWNLOAD_URL);
			const logged = JSON.stringify(warnSpy.mock.calls);
			expect(logged).not.toContain(DOWNLOAD_URL);
			expect(logged).not.toContain("secret");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("makes at most one requestdl call per ready torrent and none for processing", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				200,
				JSON.stringify({
					success: true, error: null, detail: "ok",
					data: [
						{
							id: 1, hash: "h1", name: "Ready.One", size: 1000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "a.mkv", size: 1000 }],
						},
						{
							id: 2, hash: "h2", name: "Processing.One", size: 2000,
							active: true, created_at: "", updated_at: "",
							download_state: "downloading", seeds: 3, peers: 5, progress: 0.3,
							download_speed: 512, upload_speed: 0,
							download_finished: false, download_present: false, cached: false,
							files: [],
						},
						{
							id: 3, hash: "h3", name: "Ready.Two", size: 3000,
							active: false, created_at: "", updated_at: "",
							download_state: "cached", seeds: 0, peers: 0, progress: 1,
							download_speed: 0, upload_speed: 0,
							download_finished: true, download_present: true, cached: true,
							files: [{ id: 0, name: "b.mkv", size: 3000 }],
						},
					],
				}),
			);
		let dlCalls = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(() => {
				dlCalls++;
				return {
					statusCode: 200,
					data: JSON.stringify({
						success: true, error: null, detail: "ok",
						data: "https://tb-cdn.example/dld/link?token=x",
					}),
				};
			})
			.times(2);
		interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(makeCommandInteraction("status")),
		);
		await waitOnExecutionContext(ctx);

		// 2 ready + 1 processing = exactly 2 requestdl calls.
		expect(dlCalls).toBe(2);
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
