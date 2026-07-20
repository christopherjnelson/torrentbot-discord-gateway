import { describe, expect, it } from "vitest";
import {
	authorizeGuild,
	getConfig,
	guildAuthMessage,
	isGuildAuthorized,
	type AppConfig,
} from "../src/config";

const TEST_GUILD = "123456789012345678";
const OTHER_GUILD = "987654321098765432";

function configWith(allowedGuildIds: string): AppConfig {
	return getConfig({
		TORBOX_ALLOWED_GUILD_IDS: allowedGuildIds,
	} as unknown as Env);
}

describe("TORBOX_ALLOWED_GUILD_IDS parsing", () => {
	it("accepts a single valid guild ID", () => {
		const cfg = configWith(TEST_GUILD);
		expect([...cfg.torboxAllowedGuildIds]).toEqual([TEST_GUILD]);
	});

	it("accepts multiple comma-separated guild IDs", () => {
		const cfg = configWith(`${OTHER_GUILD},${TEST_GUILD}`);
		expect(cfg.torboxAllowedGuildIds.size).toBe(2);
		expect(cfg.torboxAllowedGuildIds.has(TEST_GUILD)).toBe(true);
		expect(cfg.torboxAllowedGuildIds.has(OTHER_GUILD)).toBe(true);
	});

	it("trims whitespace around entries", () => {
		const cfg = configWith(`  ${TEST_GUILD} ,  ${OTHER_GUILD}  `);
		expect([...cfg.torboxAllowedGuildIds].sort()).toEqual(
			[OTHER_GUILD, TEST_GUILD].sort(),
		);
	});

	it("ignores empty entries caused by repeated commas", () => {
		const cfg = configWith(`,${TEST_GUILD},,${OTHER_GUILD},,`);
		expect(cfg.torboxAllowedGuildIds.size).toBe(2);
	});

	it("denies access when configuration is missing", () => {
		const cfg = configWith("");
		expect(cfg.torboxAllowedGuildIds.size).toBe(0);
		expect(authorizeGuild(TEST_GUILD, cfg.torboxAllowedGuildIds)).toBe(
			"configuration-unavailable",
		);
	});

	it("denies access when configuration is empty after trimming", () => {
		const cfg = configWith("   ");
		expect(cfg.torboxAllowedGuildIds.size).toBe(0);
		expect(authorizeGuild(TEST_GUILD, cfg.torboxAllowedGuildIds)).toBe(
			"configuration-unavailable",
		);
	});

	it("fails closed when a guild ID is malformed", () => {
		const cfg = configWith("not-a-snowflake");
		expect(cfg.torboxAllowedGuildIds.size).toBe(0);
		expect(authorizeGuild("not-a-snowflake", cfg.torboxAllowedGuildIds)).toBe(
			"configuration-unavailable",
		);
	});

	it("fails closed when any entry in a list is malformed", () => {
		const cfg = configWith(`${TEST_GUILD},bad-id,${OTHER_GUILD}`);
		expect(cfg.torboxAllowedGuildIds.size).toBe(0);
	});

	it("rejects non-decimal snowflake-like strings", () => {
		expect(configWith("123abc").torboxAllowedGuildIds.size).toBe(0);
		expect(configWith("12.34").torboxAllowedGuildIds.size).toBe(0);
		expect(configWith("-123").torboxAllowedGuildIds.size).toBe(0);
		expect(configWith("+123").torboxAllowedGuildIds.size).toBe(0);
	});

	it("does not grant access via the previous user-ID variable", () => {
		const cfg = getConfig({
			TORBOX_ALLOWED_USER_IDS: "234752290047655936",
			TORBOX_ALLOWED_GUILD_IDS: "",
		} as unknown as Env);
		expect(cfg.torboxAllowedGuildIds.size).toBe(0);
		expect(authorizeGuild(TEST_GUILD, cfg.torboxAllowedGuildIds)).toBe(
			"configuration-unavailable",
		);
	});
});

describe("authorizeGuild", () => {
	const allowed = new Set([TEST_GUILD]);

	it("allows an interaction from an authorized guild", () => {
		expect(authorizeGuild(TEST_GUILD, allowed)).toBe("allowed");
		expect(isGuildAuthorized(TEST_GUILD, allowed)).toBe(true);
	});

	it("rejects an interaction from an unauthorized guild", () => {
		expect(authorizeGuild(OTHER_GUILD, allowed)).toBe("unauthorized-guild");
		expect(isGuildAuthorized(OTHER_GUILD, allowed)).toBe(false);
	});

	it("rejects a DM (missing guild_id)", () => {
		expect(authorizeGuild(undefined, allowed)).toBe("direct-message");
		expect(isGuildAuthorized(undefined, allowed)).toBe(false);
	});

	it("rejects an empty-string guild_id as a DM", () => {
		expect(authorizeGuild("", allowed)).toBe("direct-message");
	});

	it("returns configuration-unavailable when the allowlist is empty", () => {
		expect(authorizeGuild(TEST_GUILD, new Set())).toBe(
			"configuration-unavailable",
		);
	});
});

describe("guildAuthMessage", () => {
	it("maps each non-allowed status to a concise user message", () => {
		expect(guildAuthMessage("direct-message")).toBe(
			"TorrentBot can only be used in an authorized server.",
		);
		expect(guildAuthMessage("unauthorized-guild")).toBe(
			"TorrentBot is not enabled for this server.",
		);
		expect(guildAuthMessage("configuration-unavailable")).toBe(
			"TorrentBot authorization is not configured correctly.",
		);
		expect(guildAuthMessage("allowed")).toBe("");
	});

	it("never exposes environment-variable names or config contents", () => {
		for (const status of [
			"direct-message",
			"unauthorized-guild",
			"configuration-unavailable",
		] as const) {
			const msg = guildAuthMessage(status);
			expect(msg).not.toContain("TORBOX_ALLOWED_GUILD_IDS");
			expect(msg).not.toContain("TORBOX_ALLOWED_USER_IDS");
			expect(msg).not.toContain("guild");
			expect(msg).not.toContain("ID");
		}
	});
});
