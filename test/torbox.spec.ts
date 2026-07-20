import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createTorrent,
	findTorrentByHash,
	getTorrentById,
	listTorrents,
	requestDownloadLink,
	selectDownloadTarget,
	waitForTorrentReady,
} from "../src/services/torbox";
import type { TorboxTorrent } from "../src/types/torbox";
import {
	UpstreamApiError,
	UpstreamParseError,
	UpstreamStatusError,
	UpstreamTimeoutError,
} from "../src/utils/errors";
import { isValidMagnetUri } from "../src/utils/magnet";

const CREATE_OK = JSON.stringify({
	success: true,
	error: null,
	detail: "Torrent Added Successfully",
	data: { hash: "abc123hash", torrent_id: 42, auth_id: "auth-x" },
});

const DUPLICATE_BODY = JSON.stringify({
	success: false,
	error: "DUPLICATE_ITEM",
	detail: "This item already exists.",
	data: null,
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
		{
			id: 43,
			hash: "def456hash",
			name: "Some.Old.Movie.720p",
			size: 734003200,
			active: false,
			created_at: "2026-03-01T10:00:00Z",
			updated_at: "2026-03-02T10:00:00Z",
			download_state: "cached",
			seeds: 0,
			peers: 0,
			progress: 1,
			download_speed: 0,
			upload_speed: 0,
			download_finished: true,
			cached: true,
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

function interceptCreate(replyStatus: number, replyBody: string) {
	const seen: { authorization?: string; body?: string } = {};
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
		.reply((opts) => {
			const headers = opts.headers as Record<string, string>;
			seen.authorization = headers.authorization ?? headers.Authorization;
			seen.body = String(opts.body);
			return { statusCode: replyStatus, data: replyBody };
		});
	return seen;
}

describe("createTorrent", () => {
	it("posts the magnet as multipart form with bearer auth", async () => {
		const seen = interceptCreate(200, CREATE_OK);

		const created = await createTorrent("magnet:?xt=urn:btih:abc", {
			apiKey: "torbox-key",
		});

		expect(created).toEqual({
			hash: "abc123hash",
			torrent_id: 42,
			auth_id: "auth-x",
		});
		expect(seen.authorization).toBe("Bearer torbox-key");
		expect(seen.body).toContain('name="magnet"');
		expect(seen.body).toContain("magnet:?xt=urn:btih:abc");
	});

	it("maps structured failures to UpstreamApiError with detail", async () => {
		interceptCreate(400, DUPLICATE_BODY);
		await expect(
			createTorrent("magnet:?xt=urn:btih:abc", { apiKey: "k" }),
		).rejects.toMatchObject({
			name: "UpstreamApiError",
			code: "DUPLICATE_ITEM",
			message: "This item already exists.",
		});
	});

	it("maps success:false on HTTP 200 to UpstreamApiError", async () => {
		interceptCreate(200, DUPLICATE_BODY);
		await expect(
			createTorrent("magnet:?xt=urn:btih:abc", { apiKey: "k" }),
		).rejects.toBeInstanceOf(UpstreamApiError);
	});

	it("maps non-JSON error bodies to UpstreamStatusError", async () => {
		interceptCreate(502, "Bad Gateway");
		await expect(
			createTorrent("magnet:?xt=urn:btih:abc", { apiKey: "k" }),
		).rejects.toMatchObject({ name: "UpstreamStatusError", status: 502 });
	});

	it("times out", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
			.reply(200, CREATE_OK)
			.delay(200);
		await expect(
			createTorrent("magnet:?xt=urn:btih:abc", { apiKey: "k", timeoutMs: 25 }),
		).rejects.toBeInstanceOf(UpstreamTimeoutError);
	});
});

describe("listTorrents", () => {
	it("normalizes the torrent list and drops private fields", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, MYLIST_OK);

		const torrents = await listTorrents({ apiKey: "k" });

		expect(torrents).toHaveLength(2);
		expect(torrents[0]).toMatchObject({
			id: 42,
			name: "Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-GRP",
			download_state: "downloading",
			progress: 0.45,
			seeds: 12,
			cached: false,
		});
		// The normalized model must not retain private fields.
		expect(torrents[0]).not.toHaveProperty("magnet");
		expect(torrents[0]).not.toHaveProperty("download_path");
	});

	it("passes the id filter as a query parameter", async () => {
		let seenPath: string | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply((opts) => {
				seenPath = opts.path;
				return { statusCode: 200, data: MYLIST_OK };
			});

		await listTorrents({ apiKey: "k", id: 42 });

		const url = new URL(`https://api.torbox.app${seenPath}`);
		expect(url.searchParams.get("id")).toBe("42");
	});

	it("surfaces auth failures with detail", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				403,
				JSON.stringify({
					success: false,
					error: "BAD_TOKEN",
					detail: "Invalid API token.",
					data: null,
				}),
			);
		await expect(listTorrents({ apiKey: "bad" })).rejects.toMatchObject({
			name: "UpstreamApiError",
			code: "BAD_TOKEN",
		});
	});

	it("throws UpstreamStatusError for non-JSON failures", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(500, "boom");
		await expect(listTorrents({ apiKey: "k" })).rejects.toBeInstanceOf(
			UpstreamStatusError,
		);
	});
});

describe("isValidMagnetUri", () => {
	it("accepts btih v1 magnets (hex and base32)", () => {
		expect(
			isValidMagnetUri(
				"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
			),
		).toBe(true);
		expect(
			isValidMagnetUri(
				"magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=name",
			),
		).toBe(true);
	});

	it("accepts magnets with extra parameters", () => {
		expect(
			isValidMagnetUri(
				"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x&tr=udp%3A%2F%2Ftracker",
			),
		).toBe(true);
	});

	it("rejects non-magnets and malformed magnets", () => {
		expect(isValidMagnetUri("https://example.com/file.torrent")).toBe(false);
		expect(isValidMagnetUri("magnet:?xt=urn:btih:short")).toBe(false);
		expect(isValidMagnetUri("magnet:?dn=no-hash")).toBe(false);
		expect(isValidMagnetUri("")).toBe(false);
		expect(isValidMagnetUri("magnet: ?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")).toBe(false);
	});
});

/** A ready single-file torrent as returned by mylist (raw upstream shape). */
function rawTorrent(overrides: Record<string, unknown> = {}) {
	return {
		id: 42,
		hash: "abcdef0123456789abcdef0123456789abcdef01",
		name: "Backrooms.2026.1080p.WEB-DL.x264-GRP",
		size: 1468006400,
		active: false,
		created_at: "2026-07-20T00:00:00Z",
		updated_at: "2026-07-20T00:00:10Z",
		download_state: "cached",
		seeds: 0,
		peers: 0,
		progress: 1,
		download_speed: 0,
		upload_speed: 0,
		download_finished: true,
		download_present: true,
		cached: true,
		magnet: "magnet:?xt=urn:btih:secret",
		download_path: "/private/path",
		files: [
			{
				id: 0,
				name: "Backrooms.2026.1080p.WEB-DL.x264-GRP.mkv",
				size: 1468006400,
				md5: "secret-md5",
				s3_path: "/private/s3",
			},
		],
		...overrides,
	};
}

function mylistBody(data: unknown): string {
	return JSON.stringify({
		success: true,
		error: null,
		detail: "Torrent list retrieved successfully.",
		data,
	});
}

const NO_SLEEP = () => Promise.resolve();

describe("getTorrentById", () => {
	it("normalizes a single-object response (documented id shape)", async () => {
		let seenPath: string | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply((opts) => {
				seenPath = opts.path;
				return { statusCode: 200, data: mylistBody(rawTorrent()) };
			});

		const torrent = await getTorrentById(42, { apiKey: "k" });

		expect(torrent).not.toBeNull();
		expect(torrent?.id).toBe(42);
		expect(torrent?.download_finished).toBe(true);
		expect(torrent?.files).toEqual([
			{
				id: 0,
				name: "Backrooms.2026.1080p.WEB-DL.x264-GRP.mkv",
				size: 1468006400,
			},
		]);
		// The normalized model must not retain private fields.
		expect(torrent).not.toHaveProperty("magnet");
		expect(torrent?.files[0]).not.toHaveProperty("s3_path");
		// Fresh data is required for polling: bypass_cache must be sent.
		const url = new URL(`https://api.torbox.app${seenPath}`);
		expect(url.searchParams.get("id")).toBe("42");
		expect(url.searchParams.get("bypass_cache")).toBe("true");
	});

	it("tolerates an array response shape", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, mylistBody([rawTorrent()]));

		const torrent = await getTorrentById(42, { apiKey: "k" });
		expect(torrent?.id).toBe(42);
	});

	it("returns null on ITEM_NOT_FOUND", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				404,
				JSON.stringify({
					success: true,
					error: "ITEM_NOT_FOUND",
					detail: "No torrents found for this user.",
					data: null,
				}),
			);

		await expect(getTorrentById(99, { apiKey: "k" })).resolves.toBeNull();
	});

	it("returns null on an empty list or null data", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, mylistBody([]));
		await expect(getTorrentById(42, { apiKey: "k" })).resolves.toBeNull();

		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, mylistBody(null));
		await expect(getTorrentById(42, { apiKey: "k" })).resolves.toBeNull();
	});

	it("propagates auth failures", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				403,
				JSON.stringify({
					success: false,
					error: "BAD_TOKEN",
					detail: "Invalid API token.",
					data: null,
				}),
			);
		await expect(getTorrentById(42, { apiKey: "bad" })).rejects.toMatchObject({
			name: "UpstreamApiError",
			code: "BAD_TOKEN",
		});
	});
});

describe("findTorrentByHash", () => {
	it("finds a torrent by hash case-insensitively", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, mylistBody([rawTorrent()]));

		const found = await findTorrentByHash(
			"ABCDEF0123456789ABCDEF0123456789ABCDEF01",
			{ apiKey: "k" },
		);
		expect(found?.id).toBe(42);
	});

	it("returns null when no torrent matches", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, mylistBody([rawTorrent()]));

		await expect(
			findTorrentByHash("0000000000000000000000000000000000000000", {
				apiKey: "k",
			}),
		).resolves.toBeNull();
	});

	it("returns null when the account list is ITEM_NOT_FOUND", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(
				404,
				JSON.stringify({
					success: true,
					error: "ITEM_NOT_FOUND",
					detail: "No torrents found for this user.",
					data: null,
				}),
			);
		await expect(
			findTorrentByHash("abcdef0123456789abcdef0123456789abcdef01", {
				apiKey: "k",
			}),
		).resolves.toBeNull();
	});
});

describe("requestDownloadLink", () => {
	const LINK_OK = JSON.stringify({
		success: true,
		error: null,
		detail: "Torrent download requested successfully.",
		data: "https://tb-cdn.example/dld/11111111-2222-3333-4444-555555555555?token=abc",
	});

	it("requests a file link with the documented parameters and auth", async () => {
		let seenPath: string | undefined;
		let seenAuth: string | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply((opts) => {
				seenPath = opts.path;
				const headers = opts.headers as Record<string, string>;
				seenAuth = headers.authorization ?? headers.Authorization;
				return { statusCode: 200, data: LINK_OK };
			});

		const url = await requestDownloadLink({
			apiKey: "torbox-key",
			torrentId: 42,
			fileId: 3,
		});

		expect(url).toBe(
			"https://tb-cdn.example/dld/11111111-2222-3333-4444-555555555555?token=abc",
		);
		const parsed = new URL(`https://api.torbox.app${seenPath}`);
		expect(parsed.searchParams.get("token")).toBe("torbox-key");
		expect(parsed.searchParams.get("torrent_id")).toBe("42");
		expect(parsed.searchParams.get("file_id")).toBe("3");
		expect(parsed.searchParams.get("zip_link")).toBeNull();
		expect(seenAuth).toBe("Bearer torbox-key");
	});

	it("requests a zip link for whole-torrent archives", async () => {
		let seenPath: string | undefined;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply((opts) => {
				seenPath = opts.path;
				return {
					statusCode: 200,
					data: JSON.stringify({
						success: true,
						error: null,
						detail: "Torrent download requested successfully.",
						data: "https://tb-cdn.example/zip/11111111-2222-3333-4444-555555555555?token=abc",
					}),
				};
			});

		const url = await requestDownloadLink({
			apiKey: "k",
			torrentId: 42,
			zip: true,
		});

		expect(url).toContain("/zip/");
		const parsed = new URL(`https://api.torbox.app${seenPath}`);
		expect(parsed.searchParams.get("zip_link")).toBe("true");
		expect(parsed.searchParams.get("file_id")).toBeNull();
	});

	it("rejects a non-https download URL", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "ok",
					data: "http://tb-cdn.example/dld/insecure",
				}),
			);
		await expect(
			requestDownloadLink({ apiKey: "k", torrentId: 42, fileId: 0 }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("rejects a malformed download URL", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "ok",
					data: "not a url",
				}),
			);
		await expect(
			requestDownloadLink({ apiKey: "k", torrentId: 42, fileId: 0 }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("rejects a non-string data payload", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "ok",
					data: { url: "https://tb-cdn.example/x" },
				}),
			);
		await expect(
			requestDownloadLink({ apiKey: "k", torrentId: 42, fileId: 0 }),
		).rejects.toBeInstanceOf(UpstreamParseError);
	});

	it("maps success:false to UpstreamApiError", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
			.reply(
				500,
				JSON.stringify({
					success: false,
					error: "DATABASE_ERROR",
					detail: "Failed to request torrent download. Please try again later.",
					data: null,
				}),
			);
		await expect(
			requestDownloadLink({ apiKey: "k", torrentId: 42, fileId: 0 }),
		).rejects.toMatchObject({
			name: "UpstreamApiError",
			code: "DATABASE_ERROR",
		});
	});
});

describe("selectDownloadTarget", () => {
	const base: TorboxTorrent = {
		id: 42,
		hash: "h",
		name: "n",
		size: 10,
		active: false,
		created_at: "",
		updated_at: "",
		download_state: "cached",
		seeds: 0,
		peers: 0,
		progress: 1,
		download_speed: 0,
		upload_speed: 0,
		download_finished: true,
		download_present: true,
		cached: true,
		files: [],
	};

	it("selects the only file of a single-file torrent", () => {
		const target = selectDownloadTarget({
			...base,
			files: [{ id: 7, name: "movie.mkv", size: 10 }],
		});
		expect(target).toEqual({
			kind: "file",
			file: { id: 7, name: "movie.mkv", size: 10 },
		});
	});

	it("selects the zip archive for multi-file torrents", () => {
		const target = selectDownloadTarget({
			...base,
			files: [
				{ id: 0, name: "movie.mkv", size: 10 },
				{ id: 1, name: "sample.mkv", size: 1 },
			],
		});
		expect(target).toEqual({ kind: "zip" });
	});

	it("selects the zip archive when no files are listed", () => {
		expect(selectDownloadTarget(base)).toEqual({ kind: "zip" });
	});
});

describe("waitForTorrentReady", () => {
	/**
	 * Intercept exactly `bodies.length` mylist calls, replying with the
	 * sequence. A further (unexpected) poll finds no interceptor and fails,
	 * which proves polling stops when it should.
	 */
	function interceptMyListSequence(bodies: string[]): { calls: () => number } {
		let calls = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(() => {
				const body = bodies[calls];
				calls++;
				return { statusCode: 200, data: body };
			})
			.times(bodies.length);
		return { calls: () => calls };
	}

	const poll = { intervalMs: 1, maxAttempts: 5, sleep: NO_SLEEP };

	it("returns ready on the first poll without sleeping", async () => {
		const seq = interceptMyListSequence([mylistBody(rawTorrent())]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, poll);
		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.torrent.id).toBe(42);
		}
		expect(seq.calls()).toBe(1);
	});

	it("returns ready after several polls and stops polling", async () => {
		const downloading = rawTorrent({
			download_finished: false,
			download_state: "downloading",
			progress: 0.5,
		});
		const seq = interceptMyListSequence([
			mylistBody(downloading),
			mylistBody(downloading),
			mylistBody(rawTorrent()),
		]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, poll);
		expect(result.status).toBe("ready");
		expect(seq.calls()).toBe(3);
	});

	it("stops at max attempts and reports still processing", async () => {
		const downloading = rawTorrent({
			download_finished: false,
			download_state: "downloading",
			progress: 0.2,
		});
		const seq = interceptMyListSequence([
			mylistBody(downloading),
			mylistBody(downloading),
			mylistBody(downloading),
		]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, {
			...poll,
			maxAttempts: 3,
		});
		expect(result.status).toBe("processing");
		if (result.status === "processing") {
			expect(result.torrent?.id).toBe(42);
		}
		expect(seq.calls()).toBe(3);
	});

	it("reports not-found when a seen torrent disappears", async () => {
		const seq = interceptMyListSequence([
			mylistBody(rawTorrent({ download_finished: false })),
			mylistBody(null),
		]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, poll);
		expect(result.status).toBe("not-found");
		expect(seq.calls()).toBe(2);
	});

	it("keeps polling when the torrent was never seen yet", async () => {
		const seq = interceptMyListSequence([
			mylistBody(null),
			mylistBody(rawTorrent()),
		]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, poll);
		expect(result.status).toBe("ready");
		expect(seq.calls()).toBe(2);
	});

	it("reports processing with no torrent when never found", async () => {
		const seq = interceptMyListSequence([mylistBody(null), mylistBody(null)]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, {
			...poll,
			maxAttempts: 2,
		});
		expect(result.status).toBe("processing");
		if (result.status === "processing") {
			expect(result.torrent).toBeNull();
		}
		expect(seq.calls()).toBe(2);
	});

	it("does not treat download_state completed as ready", async () => {
		// Docs: the "completed" state must not be used for completion status;
		// only download_finished counts.
		const completedState = rawTorrent({
			download_finished: false,
			download_state: "completed",
			progress: 1,
		});
		const seq = interceptMyListSequence([
			mylistBody(completedState),
			mylistBody(completedState),
		]);
		const result = await waitForTorrentReady(42, { apiKey: "k" }, {
			...poll,
			maxAttempts: 2,
		});
		expect(result.status).toBe("processing");
		expect(seq.calls()).toBe(2);
	});

	it("propagates upstream errors and stops polling", async () => {
		let calls = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(() => {
				calls++;
				return { statusCode: 500, data: "boom" };
			});
		await expect(
			waitForTorrentReady(42, { apiKey: "k" }, poll),
		).rejects.toBeInstanceOf(UpstreamStatusError);
		expect(calls).toBe(1);
	});

	it("propagates malformed responses and stops polling", async () => {
		let calls = 0;
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(() => {
				calls++;
				return { statusCode: 200, data: "not json" };
			});
		await expect(
			waitForTorrentReady(42, { apiKey: "k" }, poll),
		).rejects.toBeInstanceOf(UpstreamParseError);
		expect(calls).toBe(1);
	});
});
