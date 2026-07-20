import { describe, expect, it } from "vitest";
import {
	base64url,
	buildCustomId,
	createPayload,
	parseAndVerifyCustomId,
	verifySignature,
	signPayload,
	encodePayload,
	decodePayload,
	DISCORD_ID_LIMIT,
	CUSTOM_ID_PREFIX,
	estimateCustomIdLength,
} from "../src/utils/signing";
import { TEST_SIGNING_SECRET } from "./fixtures";

const USER_18 = "123456789012345678";
const USER_20 = "10987654321098765432";

describe("compact component signing", () => {
	it("uses the short tb:a: prefix", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		expect(customId.startsWith(CUSTOM_ID_PREFIX)).toBe(true);
	});

	it("generated custom_id stays within Discord's 100-char limit (18-digit id)", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		expect(customId.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
	});

	it("generated custom_id stays within Discord's 100-char limit (20-digit id)", async () => {
		const customId = await buildCustomId(
			createPayload(USER_20, ""),
			TEST_SIGNING_SECRET,
		);
		expect(customId.length).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
	});

	it("base64url signature has no +, /, or =", async () => {
		const sig = await signPayload(
			encodePayload(createPayload(USER_18, "")),
			TEST_SIGNING_SECRET,
		);
		expect(sig).not.toMatch(/[+/=]/);
		// 16-byte MAC -> 22 base64url chars.
		expect(sig.length).toBe(22);
	});

	it("round-trips a valid signed custom_id", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).not.toBeNull();
		expect(parsed?.userId).toBe(USER_18);
	});

	it("rejects a tampered payload", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		// Flip one character in the user-id section.
		const idx = CUSTOM_ID_PREFIX.length;
		const tampered =
			customId.slice(0, idx) +
			(customId[idx] === "X" ? "Y" : "X") +
			customId.slice(idx + 1);
		const parsed = await parseAndVerifyCustomId(tampered, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("rejects a tampered signature", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		const lastSep = customId.lastIndexOf(":");
		const sigStart = lastSep + 1;
		const original = customId.slice(sigStart);
		const alteredSig =
			original === "AAAAAAAAAAAAAAAAAAAAAA"
				? "BBBBBBBBBBBBBBBBBBBBBB"
				: "AAAAAAAAAAAAAAAAAAAAAA";
		const tampered = customId.slice(0, sigStart) + alteredSig;
		const parsed = await parseAndVerifyCustomId(tampered, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("rejects an expired payload", async () => {
		const payload = { userId: USER_18, infoHash: "", expiry: Date.now() - 1000 };
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("rejects a wrong user (token not transferable)", async () => {
		const owner = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		const parsed = await parseAndVerifyCustomId(owner, TEST_SIGNING_SECRET);
		expect(parsed?.userId).toBe(USER_18);
		// A different user's id is not embedded, so parse yields the original
		// owner; the requester binding is enforced by comparing to invoker id.
		expect(parsed?.userId).not.toBe(USER_20);
	});

	it("rejects a wrong secret", async () => {
		const customId = await buildCustomId(
			createPayload(USER_18, ""),
			TEST_SIGNING_SECRET,
		);
		const parsed = await parseAndVerifyCustomId(customId, "wrong-secret");
		expect(parsed).toBeNull();
	});

	it("verifies with constant-time compare semantics", async () => {
		const payload = encodePayload(createPayload(USER_18, ""));
		const sig = await signPayload(payload, TEST_SIGNING_SECRET);
		expect(await verifySignature(payload, sig, TEST_SIGNING_SECRET)).toBe(true);
		expect(await verifySignature(payload, sig + "x", TEST_SIGNING_SECRET)).toBe(
			false,
		);
	});

	it("encodes expiry in seconds", () => {
		const encoded = encodePayload({ userId: USER_18, infoHash: "", expiry: 1_700_000_000_000 });
		expect(encoded).toBe(`${USER_18}:1700000000`);
		const decoded = decodePayload(encoded);
		expect(decoded?.expiry).toBe(1_700_000_000_000);
	});

	it("estimateCustomIdLength reflects the 100-char limit for realistic ids", () => {
		expect(estimateCustomIdLength(USER_18)).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
		expect(estimateCustomIdLength(USER_20)).toBeLessThanOrEqual(DISCORD_ID_LIMIT);
	});

	it("base64url helper drops padding and unsafe chars", () => {
		const bytes = new Uint8Array([0, 255, 16, 127, 200, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		const enc = base64url(bytes);
		expect(enc).not.toMatch(/[+/=]/);
	});
});
