import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { editOriginalResponse, DiscordApiError } from "../src/discord/client";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_INTERACTION_TOKEN,
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
			{
				title: "Release A",
				sizeBytes: 2147483648,
				seeders: 7049,
				source: "The Pirate Bay",
				infoHash: "0123456789ABCDEF0123456789ABCDEF01234567",
			},
			{
				title: "Release B",
				sizeBytes: null,
				seeders: null,
				source: null,
				infoHash: "89abcdef012345670123456789abcdef01234567",
			},
		] as any;
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

		// Option 0: full metadata -> "size • n seeds • source".
		const opt0 = select.options[0];
		expect(opt0.label).toBe("Release A");
		expect(opt0.description).toContain("2 GiB");
		expect(opt0.description).toContain("7049 seeds");
		expect(opt0.description).toContain("The Pirate Bay");
		expect(opt0.description).not.toContain("undefined");
		// Info hash is the hidden value only — never in label/description.
		expect(opt0.value).toBe("0123456789ABCDEF0123456789ABCDEF01234567");
		expect(opt0.label).not.toContain(opt0.value);
		expect(opt0.description).not.toContain(opt0.value);

		// Option 1: missing metadata is omitted cleanly (no placeholder).
		const opt1 = select.options[1];
		expect(opt1.description).toBeUndefined();
		expect(opt1.label).toBe("Release B");

		// Release menus use the dedicated ten-result feature cap.
		expect(select.options.length).toBeLessThanOrEqual(10);
	});

	it("returns null when no results carry an info hash", async () => {
		const components = await buildSearchComponents(
			[{ title: "No hash", sizeBytes: null, seeders: null, source: null, infoHash: null }] as any,
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
		// Best-effort TorBox cache check: nothing cached (data: null) so no
		// badges are appended and the descriptions stay unchanged.
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
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });

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

		// Failing followup create: 50035 invalid form body.
		fetchMock
			.get("https://discord.com")
			.intercept({
				path: (p) => /^\/api\/v10\/webhooks\/[^/]+\/[^/]+$/.test(p),
				method: "POST",
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
		// The menu is still removed via the UPDATE_MESSAGE ack.
		expect((await response.json() as any).type).toBe(7);
		await waitOnExecutionContext(ctx);

		// The new shared helper logs the context string plus a structured
		// object carrying only status/code/discordMessage/fieldErrors.
		expect(warnSpy.mock.calls).toHaveLength(1);
		const [context, diag] = warnSpy.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(context).toBe("failed to edit interaction response");
		expect(diag).toMatchObject({
			status: 400,
			code: 50035,
			discordMessage: "Invalid Form Body",
		});
		expect(Array.isArray(diag.fieldErrors)).toBe(true);
		expect((diag.fieldErrors as string[]).join("|")).toContain(
			"data.components",
		);

		const logged = JSON.stringify(warnSpy.mock.calls);
		// No secrets in the logs: no token, no signed custom_id.
		expect(logged).not.toContain(customId);
		expect(logged).not.toContain(TEST_INTERACTION_TOKEN);
		warnSpy.mockRestore();
	});
});

describe("search response content formatting", () => {
	it("uses the concise query heading and no numbered list", async () => {
		const { formatSearchResults } = await import("../src/commands/search");
		const content = formatSearchResults("backrooms", [
			{ title: "x", sizeBytes: 1, seeders: 1, source: "y", infoHash: "a" },
		] as any);
		expect(content).toBe("Choose a release for **backrooms**:");
		expect(content).not.toContain("1.");
		expect(content).not.toContain("Top");
	});

	it("reports no results with a concise message", async () => {
		const { formatSearchResults } = await import("../src/commands/search");
		const content = formatSearchResults("nothing", []);
		expect(content).toBe("No results found for `nothing`.");
	});

	it("joins available metadata with a bullet and omits missing", async () => {
		const { formatResultDescription } = await import("../src/commands/search");
		const full = formatResultDescription({
			title: "t",
			sizeBytes: 2147483648,
			seeders: 7049,
			source: "The Pirate Bay",
		} as any);
		expect(full).toBe("2 GiB • 7049 seeds • The Pirate Bay");

		const sparse = formatResultDescription({
			title: "t",
			sizeBytes: null,
			seeders: null,
			source: null,
		} as any);
		expect(sparse).toBe("");
	});

	it("does not leak the info hash or magnet in the description", async () => {
		const { formatResultDescription } = await import("../src/commands/search");
		const desc = formatResultDescription({
			title: "t",
			sizeBytes: 1000,
			seeders: 5,
			source: "Tracker",
		} as any);
		expect(desc).not.toContain("btih");
		expect(desc).not.toContain("magnet");
	});
});
