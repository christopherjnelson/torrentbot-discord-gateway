import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { editOriginalResponse, DiscordApiError } from "../src/discord/client";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_USER_ID,
} from "./helpers";
import { PROWLARR_TWO_ITEM_JSON, TEST_SIGNING_SECRET } from "./fixtures";
import { buildSearchComponents } from "../src/commands/component";
import { DISCORD_ID_LIMIT } from "../src/utils/signing";

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

describe("/search select menu payload", () => {
	it("builds a valid action-row / string-select structure", async () => {
		const results = [
			{ title: "Release A", infoHash: "0123456789ABCDEF0123456789ABCDEF01234567" },
			{ title: "Release B", infoHash: "89abcdef012345670123456789abcdef01234567" },
		];
		const components = (await buildSearchComponents(
			results,
			TEST_USER_ID,
			TEST_SIGNING_SECRET,
		)) as any[];
		expect(components).not.toBeNull();
		expect(components).toHaveLength(1);

		const row = components[0];
		expect(row.type).toBe(1); // ActionRow
		expect(row.components).toHaveLength(1);

		const select = row.components[0];
		expect(select.type).toBe(3); // StringSelect
		expect(typeof select.custom_id).toBe("string");
		expect(select.custom_id.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
		expect(Array.isArray(select.options)).toBe(true);

		for (const opt of select.options) {
			expect(opt).toHaveProperty("label");
			expect(opt).toHaveProperty("value");
			expect(opt.label.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
			expect(opt.value.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
		}
		// No more than five options for this feature.
		expect(select.options.length).toBeLessThanOrEqual(5);
	});

	it("returns null when no results carry an info hash", async () => {
		const components = await buildSearchComponents(
			[{ title: "No hash", infoHash: null }],
			TEST_USER_ID,
			TEST_SIGNING_SECRET,
		);
		expect(components).toBeNull();
	});

	it("the deferred /search edit carries the select menu and clears thinking", async () => {
		fetchMock
			.get("https://prowlarr.test")
			.intercept({ path: /^\/api\/v1\/search/ })
			.reply(200, PROWLARR_TWO_ITEM_JSON, {
				headers: { "content-type": "application/json" },
			});
		const { captured } = interceptOriginalResponseEdit();

		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(
				makeCommandInteraction("search", [
					{ name: "query", type: 3, value: "blade runner" },
				]),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 5 });

		await waitOnExecutionContext(ctx);

		expect(captured).toHaveLength(1);
		const edit = captured[0] as any;
		expect(Array.isArray(edit.body.components)).toBe(true);
		const row = edit.body.components[0];
		expect(row.type).toBe(1);
		const select = row.components[0];
		expect(select.type).toBe(3);
		expect(select.custom_id.startsWith("tb:a:")).toBe(true);
		expect(select.custom_id.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
	});
});

describe("Discord edit error diagnostics", () => {
	it("throws a sanitized DiscordApiError and logs no secrets", async () => {
		fetchMock
			.get("https://discord.com")
			.intercept({
				path: (p) => p.includes("/webhooks/") && p.endsWith("/messages/@original"),
				method: "PATCH",
			})
			.reply(400, JSON.stringify({
				code: 50035,
				message: "Invalid Form Body",
				errors: {
					data: {
						components: { "0": { components: { "0": { custom_id: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 100 or fewer in length." }] } } } } },
					},
				},
			}));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		let thrown: unknown = null;
		try {
			await editOriginalResponse("app-1", "token-secret", {
				content: "hi",
				components: [{ type: 1, components: [{ type: 3, custom_id: "x".repeat(200), options: [] }] }],
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(DiscordApiError);
		const err = thrown as DiscordApiError;
		expect(err.status).toBe(400);
		expect(err.code).toBe(50035);
		expect(err.discordMessage).toBe("Invalid Form Body");
		expect(err.fieldErrors).toContain("data.components.0.components.0.custom_id");

		// No secrets in the logs.
		const logged = JSON.stringify(warnSpy.mock.calls);
		expect(logged).not.toContain("token-secret");
		expect(logged).not.toContain("x".repeat(200));
		expect(logged).not.toContain("app-1");
		warnSpy.mockRestore();
	});

	it("component interaction logs sanitized diagnostics on edit failure", async () => {
		// Build a valid signed custom_id for the test user.
		const { buildCustomId, createPayload } = await import("../src/utils/signing");
		const customId = await buildCustomId(
			createPayload(TEST_USER_ID, ""),
			TEST_SIGNING_SECRET,
		);

		// Failing edit: 50035 invalid form body with the long custom_id.
		fetchMock
			.get("https://discord.com")
			.intercept({
				path: (p) => p.includes("/webhooks/") && p.endsWith("/messages/@original"),
				method: "PATCH",
			})
			.reply(400, JSON.stringify({
				code: 50035,
				message: "Invalid Form Body",
				errors: { data: { components: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH" }] } } },
			}));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { ctx, response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["0123456789ABCDEF0123456789ABCDEF01234567"],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);

		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const logged = JSON.stringify(warnSpy.mock.calls);
		expect(logged).toContain("discord API error");
		expect(logged).toContain(50035);
		expect(logged).toContain("data.components");
		// The signed custom_id (derived from the user id) must not appear.
		expect(logged).not.toContain(customId);
		warnSpy.mockRestore();
	});
});
