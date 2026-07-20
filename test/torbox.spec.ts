import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTorrent, listTorrents } from "../src/services/torbox";
import {
	UpstreamApiError,
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
