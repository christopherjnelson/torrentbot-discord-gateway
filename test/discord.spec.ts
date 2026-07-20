import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TORZNAB_EMPTY_XML, TORZNAB_TWO_ITEM_XML } from "./fixtures";
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

function mockVoyager(status: number, body: string) {
	return fetchMock
		.get("https://search-api.torbox.app")
		.intercept({ path: /^\/torznab\/api/ })
		.reply(status, body, { headers: { "content-type": "application/xml" } });
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
			JSON.stringify(makeInteraction({ type: 3 })),
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

	it("responds ephemerally when no search API key is configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ VOYAGER_API_KEY: "", TORBOX_API_KEY: "" },
		);
		const body = (await response.json()) as {
			data: { flags?: number; content: string };
		};
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("not configured");
	});

	it("defers, then edits the original response with formatted results", async () => {
		mockVoyager(200, TORZNAB_TWO_ITEM_XML);
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
		// Magnet URIs must never appear in Discord output.
		expect(content).not.toContain("magnet:?xt");
		expect(content).not.toContain("btih");
		expect(content.length).toBeLessThanOrEqual(2000);
	});

	it("reports empty result sets", async () => {
		mockVoyager(200, TORZNAB_EMPTY_XML);
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
		mockVoyager(500, "boom");
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

	it("reports upstream rate limiting", async () => {
		mockVoyager(429, '{"error":"Rate limit exceeded: 0 per 1 minute"}');
		const { captured } = interceptOriginalResponseEdit();

		const { ctx } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
		);
		await waitOnExecutionContext(ctx);

		expect(captured[0].body.content).toContain("rate limiting");
	});

	it("reports upstream timeouts", async () => {
		fetchMock
			.get("https://search-api.torbox.app")
			.intercept({ path: /^\/torznab\/api/ })
			.reply(200, TORZNAB_EMPTY_XML)
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

	it("reports malformed upstream XML gracefully", async () => {
		mockVoyager(200, "<rss><channel><title>broken");
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
