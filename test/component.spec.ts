import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	buildCustomId,
	createPayload,
	parseAndVerifyCustomId,
	isValidInfoHash,
	CUSTOM_ID_PREFIX,
} from "../src/utils/signing";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	dispatchInteraction,
	interceptOriginalResponseEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_USER_ID,
	TEST_INTERACTION_TOKEN,
	TEST_APPLICATION_ID,
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

describe("component signing utility", () => {
	it("creates valid payloads and verifies them", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		expect(customId).toContain(CUSTOM_ID_PREFIX);

		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).not.toBeNull();
		expect(parsed?.userId).toBe("user-1");
		expect(parsed?.infoHash).toBe("a".repeat(40));
	});

	it("rejects tampered payloads", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		// Tamper with the payload
		const tampered = customId.slice(0, -10) + "tampered00";
		const parsed = await parseAndVerifyCustomId(tampered, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("rejects wrong secret", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const parsed = await parseAndVerifyCustomId(customId, "wrong-secret");
		expect(parsed).toBeNull();
	});

	it("rejects expired payloads", async () => {
		const payload = {
			userId: "user-1",
			infoHash: "a".repeat(40),
			expiry: Date.now() - 1000, // expired
		};
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("validates info hashes correctly", () => {
		expect(isValidInfoHash("a".repeat(40))).toBe(true);
		expect(isValidInfoHash("A".repeat(40))).toBe(true);
		expect(isValidInfoHash("g".repeat(40))).toBe(false); // 'g' is not hex
		expect(isValidInfoHash("a".repeat(39))).toBe(false); // too short
		expect(isValidInfoHash("a".repeat(41))).toBe(false); // too long
	});
});

describe("component interaction handling", () => {
	it("rejects interaction without custom_id", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: { values: ["hash"] } as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Invalid component interaction");
	});

	it("rejects when signing secret is not configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: "torrentbot:add-result:invalid",
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: "" },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("not configured");
	});

	it("rejects tampered custom_id", async () => {
		const { response, ctx } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: "torrentbot:add-result:invalid|tampered",
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Adding to TorBox");

		// Wait for background processing and mock the Discord API
		const { captured } = interceptOriginalResponseEdit();
		await waitOnExecutionContext(ctx);

		// The background process should edit the message with an error
		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0].body.content).toContain("expired or is invalid");
	});

	it("rejects wrong user", async () => {
		const payload = createPayload("other-user", "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response, ctx } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Adding to TorBox");

		const { captured } = interceptOriginalResponseEdit();
		await waitOnExecutionContext(ctx);

		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0].body.content).toContain("someone else");
	});

	it("rejects non-allowlisted user", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response, ctx } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_ALLOWED_USER_IDS: "other-user",
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Adding to TorBox");

		const { captured } = interceptOriginalResponseEdit();
		await waitOnExecutionContext(ctx);

		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0].body.content).toContain("not authorized");
	});

	it("rejects invalid info hash in selection", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["invalid-hash"],
					} as any,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_ALLOWED_USER_IDS: TEST_USER_ID,
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		// Invalid hash is rejected immediately (before background processing)
		expect(body.data.content).toContain("Invalid selection");
	});

	it("rejects when TorBox is not configured", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response, ctx } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_API_KEY: "",
				TORBOX_ALLOWED_USER_IDS: TEST_USER_ID,
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Adding to TorBox");

		const { captured } = interceptOriginalResponseEdit();
		await waitOnExecutionContext(ctx);

		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0].body.content).toContain("not configured");
	});
});
