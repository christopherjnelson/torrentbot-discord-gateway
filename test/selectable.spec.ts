import { describe, expect, it } from "vitest";
import {
	buildSelectableOptions,
	getSelectableResults,
} from "../src/utils/selectable";
import { SELECT_OPTION_CAP } from "../src/utils/signing";
import type { TorrentResult } from "../src/types/search";

/** Build a minimal TorrentResult with the given title and info hash. */
function result(title: string, infoHash: string | null): TorrentResult {
	return {
		title,
		sizeBytes: 1468006400,
		seeders: 10,
		peers: 20,
		categoryId: 2040,
		source: "Tracker",
		link: null,
		infoHash,
		magnetUri: null,
		publishedAt: null,
	};
}

const HASH_A = "0123456789abcdef0123456789abcdef01234567";
const HASH_B = "89abcdef012345670123456789abcdef01234567";
const HASH_C = "fedcba9876543210fedcba9876543210fedcba98";
const HASH_D = "1111111111111111111111111111111111111111";
const HASH_E = "2222222222222222222222222222222222222222";

describe("getSelectableResults", () => {
	it("keeps only results with a valid 40-char hex info hash", () => {
		const input = [
			result("Valid A", HASH_A),
			result("Short hash", "short"),
			result("Non-hex", "g".repeat(40)),
			result("Missing hash", null),
			result("Valid B", HASH_B),
		];
		const out = getSelectableResults(input);
		expect(out.map((r) => r.title)).toEqual(["Valid A", "Valid B"]);
	});

	it("deduplicates by normalized (lowercased) hash, first occurrence wins", () => {
		const first = result("First", HASH_A);
		const second = result("Second", HASH_A.toLowerCase());
		const third = result("Third", HASH_A.toUpperCase());
		const out = getSelectableResults([first, second, third]);
		expect(out).toHaveLength(1);
		// First occurrence is preserved (identity, not just title).
		expect(out[0]).toBe(first);
	});

	it("preserves original order for distinct hashes", () => {
		const input = [result("C", HASH_C), result("A", HASH_A), result("B", HASH_B)];
		const out = getSelectableResults(input);
		expect(out.map((r) => r.infoHash)).toEqual([HASH_C, HASH_A, HASH_B]);
	});

	it("does not mutate the input array", () => {
		const input = [result("A", HASH_A), result("B", HASH_B)];
		const snapshot = [...input];
		getSelectableResults(input);
		expect(input).toEqual(snapshot);
	});

	it("returns an empty array for empty input", () => {
		expect(getSelectableResults([])).toEqual([]);
	});
});

describe("buildSelectableOptions", () => {
	it("deduplicates by lowercase hash before applying the cap", () => {
		const input = [
			result("First", HASH_A),
			result("Dup", HASH_A.toUpperCase()),
			result("Second", HASH_B),
		];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		expect(out.map((r) => r.title)).toEqual(["First", "Second"]);
	});

	it("drops results whose sanitized label is empty", () => {
		const input = [
			result("   ", HASH_A),
			result("", HASH_B),
			result("````", HASH_C), // backticks -> single quotes -> non-empty
			result("Valid", HASH_D),
		];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		// "   " and "" sanitize to empty; "````" -> "''''" is non-empty.
		expect(out.map((r) => r.title)).toEqual(["````", "Valid"]);
	});

	it("continues scanning later results to fill the five-option cap", () => {
		// 3 valid-hash results with empty labels, then 5 valid results.
		const input = [
			result("   ", HASH_A),
			result("", HASH_B),
			result("\t\n", HASH_C),
			result("R1", HASH_D),
			result("R2", HASH_E),
			result("R3", "3333333333333333333333333333333333333333"),
			result("R4", "4444444444444444444444444444444444444444"),
			result("R5", "5555555555555555555555555555555555555555"),
		];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		expect(out).toHaveLength(5);
		expect(out.map((r) => r.title)).toEqual([
			"R1",
			"R2",
			"R3",
			"R4",
			"R5",
		]);
	});

	it("respects the cap and does not exceed it", () => {
		const input = Array.from({ length: 10 }, (_, i) =>
			result(`R${i}`, (i.toString(16).padStart(40, "0"))),
		);
		const out = buildSelectableOptions(input, 3);
		expect(out).toHaveLength(3);
	});

	it("keeps Unicode titles as valid labels", () => {
		const input = [
			result("日本語タイトル 🎬 4K", HASH_A),
			result("Русское название", HASH_B),
		];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		expect(out.map((r) => r.title)).toEqual([
			"日本語タイトル 🎬 4K",
			"Русское название",
		]);
	});

	it("returns an empty array when all labels are empty", () => {
		const input = [result("   ", HASH_A), result("", HASH_B)];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		expect(out).toEqual([]);
	});

	it("returns an empty array when no valid hashes are present", () => {
		const input = [result("No hash", null), result("Short", "x")];
		const out = buildSelectableOptions(input, SELECT_OPTION_CAP);
		expect(out).toEqual([]);
	});

	it("returns the original TorrentResult objects (not copies)", () => {
		const a = result("A", HASH_A);
		const out = buildSelectableOptions([a], SELECT_OPTION_CAP);
		expect(out[0]).toBe(a);
	});
});