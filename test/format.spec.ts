import { describe, expect, it } from "vitest";
import {
	categoryName,
	DISCORD_CONTENT_LIMIT,
	formatBytes,
	sanitizeInline,
	truncate,
} from "../src/utils/format";

describe("formatBytes", () => {
	it("formats zero and small byte counts", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
	});

	it("formats binary units", () => {
		expect(formatBytes(2048)).toBe("2 KiB");
		expect(formatBytes(1468006400)).toBe("1.4 GiB");
		expect(formatBytes(5 * 1024 ** 4)).toBe("5 TiB");
	});

	it("handles unknown or invalid input", () => {
		expect(formatBytes(null)).toBe("unknown size");
		expect(formatBytes(Number.NaN)).toBe("unknown size");
		expect(formatBytes(-5)).toBe("unknown size");
	});
});

describe("truncate", () => {
	it("leaves short text alone", () => {
		expect(truncate("abc", 3)).toBe("abc");
		expect(truncate("abc", 10)).toBe("abc");
	});

	it("truncates with an ellipsis", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("abcdef", 4).length).toBe(4);
	});
});

describe("sanitizeInline", () => {
	it("removes backticks so inline code cannot be escaped", () => {
		expect(sanitizeInline("a`b`c")).toBe("a'b'c");
	});

	it("collapses newlines and repeated whitespace", () => {
		expect(sanitizeInline("line one\n\nline   two")).toBe("line one line two");
	});

	it("strips control characters", () => {
		const withControls = `a${String.fromCharCode(7)}b${String.fromCharCode(0, 31)}c`;
		expect(sanitizeInline(withControls)).toBe("a b c");
	});

	it("caps the length", () => {
		expect(sanitizeInline("x".repeat(500), 100).length).toBe(100);
	});
});

describe("categoryName", () => {
	it("maps torznab category ranges to names", () => {
		expect(categoryName(2000)).toBe("Movies");
		expect(categoryName(2040)).toBe("Movies");
		expect(categoryName(5030)).toBe("TV");
		expect(categoryName(7000)).toBe("Books");
	});

	it("returns null for unknown or missing categories", () => {
		expect(categoryName(999)).toBe(null);
		expect(categoryName(null)).toBe(null);
		expect(categoryName(Number.NaN)).toBe(null);
	});
});

describe("limits", () => {
	it("discord content limit is the documented 2000", () => {
		expect(DISCORD_CONTENT_LIMIT).toBe(2000);
	});
});
