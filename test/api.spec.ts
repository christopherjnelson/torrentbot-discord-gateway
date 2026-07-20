import { createExecutionContext, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { isValidBearer, safeSecretEqual } from "../src/utils/auth";
import { PROWLARR_TWO_ITEM_JSON } from "./fixtures";
import { testEnv } from "./helpers";

const TOKEN = "test-internal-token";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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

function apiRequest(
	path: string,
	init: { method?: string; body?: unknown; token?: string | null } = {},
) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (init.token !== null) {
		headers.authorization = `Bearer ${init.token ?? TOKEN}`;
	}
	return new IncomingRequest(`https://example.com${path}`, {
		method: init.method ?? "POST",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

async function callApi(
	path: string,
	init: { method?: string; body?: unknown; token?: string | null } = {},
	envOverrides: Record<string, string> = {},
) {
	const ctx = createExecutionContext();
	const response = await worker.fetch!(
		apiRequest(path, init),
		testEnv(envOverrides),
		ctx,
	);
	return response;
}

const MYLIST_ONE = JSON.stringify({
	success: true,
	error: null,
	detail: "ok",
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
			files: [{ name: "movie.mkv", s3_path: "s3://private" }],
		},
	],
});

describe("internal API authentication", () => {
	it("rejects requests without an Authorization header", async () => {
		const response = await callApi(
			"/api/search",
			{ body: { query: "blade runner" }, token: null },
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Unauthorized",
		});
	});

	it("rejects a wrong token", async () => {
		const response = await callApi("/api/search", {
			body: { query: "blade runner" },
			token: "wrong-token",
		});
		expect(response.status).toBe(401);
	});

	it("rejects malformed Authorization schemes", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch!(
			new IncomingRequest("https://example.com/api/search", {
				method: "POST",
				headers: { authorization: `Token ${TOKEN}` },
				body: "{}",
			}),
			testEnv(),
			ctx,
		);
		expect(response.status).toBe(401);
	});

	it("returns 503 for every /api route when the token is not configured", async () => {
		const response = await callApi(
			"/api/search",
			{ body: { query: "blade runner" } },
			{ INTERNAL_API_TOKEN: "" },
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Internal API is not configured on this worker",
		});
	});

	it("safeSecretEqual compares correctly", async () => {
		expect(await safeSecretEqual("abc", "abc")).toBe(true);
		expect(await safeSecretEqual("abc", "abd")).toBe(false);
		expect(await safeSecretEqual("abc", "abcd")).toBe(false);
		expect(await isValidBearer("Bearer abc", "abc")).toBe(true);
		expect(await isValidBearer("bearer abc", "abc")).toBe(true);
		expect(await isValidBearer("Bearer abd", "abc")).toBe(false);
		expect(await isValidBearer(null, "abc")).toBe(false);
	});
});

describe("POST /api/search", () => {
	it("returns normalized results including magnet URIs", async () => {
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(200, PROWLARR_TWO_ITEM_JSON);

		const response = await callApi("/api/search", {
			body: { query: "blade runner" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			count: number;
			results: {
				title: string;
				seeders: number;
				magnetUri: string | null;
			}[];
		};
		expect(body.ok).toBe(true);
		expect(body.count).toBe(2);
		// Sorted by seeders descending.
		expect(body.results[0].seeders).toBe(120);
		expect(body.results[0].magnetUri).toContain("magnet:?xt=urn:btih:");
		// Prowlarr proxy URLs embed the API key and must never be propagated.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("apikey");
		expect(serialized).not.toContain("prowlarr-key");
		expect(serialized).not.toContain("/download?");
	});

	it("respects the limit parameter", async () => {
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(200, PROWLARR_TWO_ITEM_JSON);

		const response = await callApi("/api/search", {
			body: { query: "blade runner", limit: 1 },
		});
		const body = (await response.json()) as { results: unknown[] };
		expect(body.results).toHaveLength(1);
	});

	it("rejects invalid bodies and parameters", async () => {
		for (const body of [
			{ query: "" },
			{ query: "x".repeat(201) },
			{ query: 5 },
			{ query: "ok", limit: 0 },
			{ query: "ok", limit: 26 },
			{ query: "ok", limit: 1.5 },
			"not-an-object",
		]) {
			const response = await callApi("/api/search", { body });
			expect(response.status).toBe(400);
		}
	});

	it("returns 503 when Prowlarr is not configured", async () => {
		const response = await callApi(
			"/api/search",
			{ body: { query: "blade runner" } },
			{ PROWLARR_API_KEY: "" },
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Search is not configured on this worker",
		});
	});

	it("maps upstream failures to 502", async () => {
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(500, "boom");
		const response = await callApi("/api/search", {
			body: { query: "blade runner" },
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Upstream service returned HTTP 500",
		});
	});
});

describe("POST /api/torrents", () => {
	const VALID_MAGNET =
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

	it("creates a torrent", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					success: true,
					error: null,
					detail: "Torrent Added Successfully",
					data: { hash: "abc123hash", torrent_id: 42, auth_id: "x" },
				}),
			);

		const response = await callApi("/api/torrents", {
			body: { magnet: VALID_MAGNET },
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			ok: true,
			torrentId: 42,
			hash: "abc123hash",
		});
	});

	it("rejects invalid magnets", async () => {
		const response = await callApi("/api/torrents", {
			body: { magnet: "https://example.com/x.torrent" },
		});
		expect(response.status).toBe(400);
	});

	it("maps duplicates to 409", async () => {
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
		const response = await callApi("/api/torrents", {
			body: { magnet: VALID_MAGNET },
		});
		expect(response.status).toBe(409);
	});
});

describe("GET /api/torrents/:id", () => {
	it("returns a normalized torrent without private fields", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, MYLIST_ONE);

		const response = await callApi("/api/torrents/42", { method: "GET" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			torrent: Record<string, unknown>;
		};
		expect(body.ok).toBe(true);
		expect(body.torrent).toMatchObject({
			id: 42,
			state: "downloading",
			progressPercent: 45,
			seeds: 12,
		});
		const serialized = JSON.stringify(body.torrent);
		expect(serialized).not.toContain("magnet:?xt");
		expect(serialized).not.toContain("/private/path");
		expect(serialized).not.toContain("s3://");
	});

	it("returns 404 for unknown ids", async () => {
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(200, MYLIST_ONE);

		const response = await callApi("/api/torrents/999", { method: "GET" });
		expect(response.status).toBe(404);
	});

	it("rejects non-integer ids", async () => {
		const response = await callApi("/api/torrents/abc", { method: "GET" });
		expect(response.status).toBe(400);
	});
});

describe("API routing", () => {
	it("returns 404 for unknown /api routes", async () => {
		const response = await callApi("/api/nope", { method: "GET" });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "Not found" });
	});

	it("returns 404 for wrong methods on known routes", async () => {
		const response = await callApi("/api/search", { method: "GET" });
		expect(response.status).toBe(404);
	});
});
