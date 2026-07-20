import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROWLARR_EMPTY_JSON, PROWLARR_TWO_ITEM_JSON } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeInteraction,
	TEST_APPLICATION_ID,
	TEST_INTERACTION_TOKEN,
} from "./helpers";

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

describe("/search command", () => {
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
		expect(await response.json()).toEqual({ type: 5 });

		await waitOnExecutionContext(ctx);

		expect(captured).toHaveLength(1);
		const edit = captured[0];
		// Correct follow-up endpoint: application id + interaction token.
		expect(edit.path).toBe(
			`/api/v10/webhooks/${TEST_APPLICATION_ID}/${TEST_INTERACTION_TOKEN}/messages/@original`,
		);
		expect(edit.body.allowed_mentions).toEqual({ parse: [] });

		const content = edit.body.content ?? "";
		expect(content).toContain("blade runner");
		// Sorted by seeders: the 120-seed 1080p release ranks first.
		expect(content).toContain("**1.** `Blade.Runner.1982.Final.Cut.1080p");
		expect(content).toContain("1.4 GiB");
		expect(content).toContain("120 seeds");
		expect(content).toContain("Movies");
		expect(content).toContain("magnet ✓");
		expect(content).toContain("ExampleTracker");
		// Magnet URIs and Prowlarr proxy URLs (which embed the API key) must
		// never appear in Discord output.
		expect(content).not.toContain("magnet:?xt");
		expect(content).not.toContain("btih");
		expect(content).not.toContain("apikey");
		expect(content).not.toContain("prowlarr-key");
		expect(content.length).toBeLessThanOrEqual(2000);
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
