import { describe, expect, it, vi } from "vitest";
import { DiscordApiError } from "../src/discord/client";
import { UpstreamStatusError } from "../src/utils/errors";
import {
	logDiscordApiFailure,
	logUpstreamFailure,
} from "../src/commands/shared";

describe("logDiscordApiFailure", () => {
	it("logs structured status/code/discordMessage/fieldErrors for DiscordApiError", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const error = new DiscordApiError({
				status: 400,
				code: 50035,
				message: "Invalid Form Body",
				fieldErrors: ["data.components.0.options.0.value"],
			});
			logDiscordApiFailure("failed to edit interaction response", error);

			expect(warnSpy.mock.calls).toHaveLength(1);
			const [context, diag] = warnSpy.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(context).toBe("failed to edit interaction response");
			expect(diag).toEqual({
				status: 400,
				code: 50035,
				discordMessage: "Invalid Form Body",
				fieldErrors: ["data.components.0.options.0.value"],
			});
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("logs only the four safe fields and nothing else", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const error = new DiscordApiError({
				status: 500,
				code: null,
				message: "Internal Server Error",
				fieldErrors: [],
			});
			logDiscordApiFailure("ctx", error);

			const diag = warnSpy.mock.calls[0][1] as Record<string, unknown>;
			expect(Object.keys(diag).sort()).toEqual(
				["code", "discordMessage", "fieldErrors", "status"].sort(),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("falls back to classification-only logging for non-Discord errors", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const error = new UpstreamStatusError("torbox", 500);
			logDiscordApiFailure("ctx", error);

			expect(warnSpy.mock.calls).toHaveLength(1);
			const [msg] = warnSpy.mock.calls[0] as [string];
			expect(msg).toBe("ctx: UpstreamStatusError");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("falls back for plain Error instances", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			logDiscordApiFailure("ctx", new Error("boom"));
			expect(warnSpy.mock.calls).toHaveLength(1);
			expect(warnSpy.mock.calls[0][0]).toBe("ctx: Error");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("falls back for non-Error values", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			logDiscordApiFailure("ctx", "string error");
			expect(warnSpy.mock.calls).toHaveLength(1);
			expect(warnSpy.mock.calls[0][0]).toBe("ctx: unknown");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("never leaks tokens, URLs, hashes, magnets, API keys, custom IDs, or option values", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// DiscordApiError only carries status/code/message/fieldErrors;
			// none of the sensitive values below can appear in its fields.
			const error = new DiscordApiError({
				status: 400,
				code: 50035,
				message: "Invalid Form Body",
				fieldErrors: ["data.components.0.options.0.value"],
			});
			logDiscordApiFailure("failed to edit interaction response", error);

			const logged = JSON.stringify(warnSpy.mock.calls);
			const sensitive = [
				"https://discord.com/api/v10/webhooks/app-1/token-secret/messages/@original",
				"token-secret",
				"0123456789abcdef0123456789abcdef01234567",
				"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
				"test-torbox-api-key",
				"tb:a:user-1:1234567890:signature",
				"option-value-secret",
			];
			for (const value of sensitive) {
				expect(logged).not.toContain(value);
			}
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("handles a DiscordApiError with null code and message", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const error = new DiscordApiError({
				status: 502,
			});
			logDiscordApiFailure("ctx", error);

			const diag = warnSpy.mock.calls[0][1] as Record<string, unknown>;
			expect(diag).toEqual({
				status: 502,
				code: null,
				discordMessage: null,
				fieldErrors: [],
			});
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("logUpstreamFailure", () => {
	it("logs context and error class name only", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			logUpstreamFailure(
				"search failed",
				new UpstreamStatusError("prowlarr", 500),
			);
			expect(warnSpy.mock.calls).toHaveLength(1);
			expect(warnSpy.mock.calls[0][0]).toBe(
				"search failed: UpstreamStatusError",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("logs 'unknown' for non-Error values", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			logUpstreamFailure("ctx", 42);
			expect(warnSpy.mock.calls[0][0]).toBe("ctx: unknown");
		} finally {
			warnSpy.mockRestore();
		}
	});
});