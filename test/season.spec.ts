import { describe, expect, it } from "vitest";
import {
	buildSeasonComponents,
	buildTvSeasonQuery,
	formatSeasonHeading,
	seasonPageCount,
	TV_SEASON_PAGE_SIZE,
} from "../src/commands/season";
import type { TvDetails, TvSeasonSummary } from "../src/types/media";
import {
	createSeasonPayload,
	digestComponentQuery,
	parseAndVerifyCustomId,
} from "../src/utils/signing";
import { TEST_SIGNING_SECRET } from "./fixtures";
import { TEST_USER_ID } from "./helpers";

function details(seasons: TvSeasonSummary[]): TvDetails {
	return {
		id: 1396,
		mediaType: "tv",
		title: "Breaking Bad",
		originalTitle: "Breaking Bad",
		year: 2008,
		popularity: null,
		seasons,
	};
}

async function pageComponents(
	seasons: TvSeasonSummary[],
	page = 0,
	query = "breaking bad",
) {
	const queryDigest = await digestComponentQuery(query);
	const payload = createSeasonPayload(
		TEST_USER_ID,
		1396,
		page,
		queryDigest,
		Date.now() + 15 * 60 * 1000,
	);
	return buildSeasonComponents(
		details(seasons),
		query,
		payload,
		TEST_SIGNING_SECRET,
	);
}

function selectFrom(components: object[]) {
	return (
		components as Array<{
			components: Array<{
				custom_id: string;
				placeholder: string;
				options: Array<{
					label: string;
					value: string;
					description: string;
				}>;
			}>;
		}>
	)[0].components[0];
}

describe("TV season query construction", () => {
	it.each([
		["complete", "Breaking Bad complete"],
		[0, "Breaking Bad S00"],
		[1, "Breaking Bad S01"],
		[9, "Breaking Bad S09"],
		[10, "Breaking Bad S10"],
		[100, "Breaking Bad S100"],
	] as const)("builds the expected query for %s", (selection, expected) => {
		expect(buildTvSeasonQuery("  Breaking   Bad  ", selection)).toBe(expected);
	});

	it("rejects an empty title and invalid season numbers", () => {
		expect(buildTvSeasonQuery(" \n\t ", "complete")).toBeNull();
		expect(buildTvSeasonQuery("Breaking Bad", -1)).toBeNull();
		expect(buildTvSeasonQuery("Breaking Bad", 1.5)).toBeNull();
	});

	it("never appends a year, TMDB id, or episode count", () => {
		const query = buildTvSeasonQuery("Breaking Bad", 3);
		expect(query).toBe("Breaking Bad S03");
		expect(query).not.toMatch(/2008|1396|episodes|Season/);
	});
});

describe("bounded TV season menu", () => {
	it("renders Complete, Specials, numbered seasons, and exact search", async () => {
		const select = selectFrom(
			await pageComponents([
				{ seasonNumber: 0, episodeCount: 5 },
				{ seasonNumber: 1, episodeCount: 7 },
				{ seasonNumber: 2, episodeCount: null },
			]),
		);
		expect(select.options).toMatchObject([
			{
				label: "Complete series",
				description: "All seasons",
			},
			{
				label: "Specials",
				description: "S00 • 5 episodes",
			},
			{
				label: "Season 1",
				description: "S01 • 7 episodes",
			},
			{
				label: "Season 2",
				description: "S02",
			},
			{
				label: "Search exactly as entered",
				description: "Bypass season selection",
			},
		]);
		expect(select.options.at(-1)?.label).toBe("Search exactly as entered");
		expect(select.custom_id.length).toBeLessThanOrEqual(100);
		for (const option of select.options) {
			expect(option.label.length).toBeLessThanOrEqual(100);
			expect(option.description.length).toBeLessThanOrEqual(100);
			expect(option.value.length).toBeLessThanOrEqual(100);
			expect(option.value).not.toContain("Breaking Bad");
			expect(option.value).not.toContain("breaking bad");
		}
	});

	it("omits Specials when TMDB does not return season 0", async () => {
		const select = selectFrom(
			await pageComponents([{ seasonNumber: 1, episodeCount: 10 }]),
		);
		expect(select.options.map((option) => option.label)).not.toContain(
			"Specials",
		);
	});

	it("offers Complete and exact search when no valid seasons exist", async () => {
		const select = selectFrom(await pageComponents([]));
		expect(select.options.map((option) => option.label)).toEqual([
			"Complete series",
			"Search exactly as entered",
		]);
		expect(formatSeasonHeading("Example", "exact query", false)).toContain(
			"No season information was available.",
		);
	});

	it("exposes every season through signed, bounded pagination", async () => {
		const seasons = Array.from({ length: 46 }, (_, seasonNumber) => ({
			seasonNumber,
			episodeCount: seasonNumber + 1,
		}));
		expect(TV_SEASON_PAGE_SIZE).toBe(20);
		expect(seasonPageCount(seasons)).toBe(3);

		const exposed = new Set<number>();
		for (let page = 0; page < 3; page++) {
			const select = selectFrom(await pageComponents(seasons, page));
			expect(select.options.length).toBeLessThanOrEqual(25);
			expect(select.options.at(-1)?.label).toBe(
				"Search exactly as entered",
			);
			expect(
				await parseAndVerifyCustomId(
					select.custom_id,
					TEST_SIGNING_SECRET,
				),
			).toMatchObject({
				action: "season",
				userId: TEST_USER_ID,
				seriesId: 1396,
				page,
			});
			expect(
				select.options.some((option) => option.label === "Complete series"),
			).toBe(page === 0);
			expect(
				select.options.some((option) => option.label === "Previous seasons"),
			).toBe(page > 0);
			expect(
				select.options.some((option) => option.label === "Next seasons"),
			).toBe(page < 2);

			for (const option of select.options) {
				if (option.label === "Specials") {
					exposed.add(0);
				}
				const match = /^Season (\d+)$/.exec(option.label);
				if (match) {
					exposed.add(Number(match[1]));
				}
			}
		}
		expect([...exposed]).toEqual(seasons.map((season) => season.seasonNumber));
	});

	it("rejects an invalid page instead of silently omitting seasons", async () => {
		await expect(
			pageComponents([{ seasonNumber: 1, episodeCount: 1 }], 1),
		).rejects.toThrow("invalid season page state");
	});
});
