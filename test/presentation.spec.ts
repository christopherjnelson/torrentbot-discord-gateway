import { describe, expect, it } from "vitest";
import {
	actionRow,
	BUTTON_LINK,
	BUTTON_PRIMARY,
	button,
	mediaDetailsEmbed,
	tmdbPosterUrl,
	validateMessagePayload,
} from "../src/discord/presentation";
import type { MediaDetails, TvDetails } from "../src/types/media";

const movie: MediaDetails = {
	id: 11,
	mediaType: "movie",
	title: "Star Wars",
	originalTitle: "Star Wars",
	year: 1977,
	popularity: null,
	overview: `A hero\nsets out ${"far ".repeat(180)}`,
	posterPath: "/poster_file.jpg",
	genres: ["Adventure", "Science Fiction"],
	runtimeMinutes: 121,
	episodeRunTimeMinutes: null,
	status: "Released",
};

describe("media presentation", () => {
	it("builds a bounded movie embed with year, type, metadata, and HTTPS poster", () => {
		const embed = mediaDetailsEmbed(movie, "star wars");
		expect(embed.title).toBe("Star Wars");
		expect(embed.description).toContain("Movie • 1977");
		expect(embed.description?.length).toBeLessThanOrEqual(4_096);
		expect(embed.description).not.toContain("\nsets");
		expect(embed.thumbnail?.url).toBe(
			"https://image.tmdb.org/t/p/w500/poster_file.jpg",
		);
		expect(embed.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Runtime", value: "121 min" }),
				expect.objectContaining({
					name: "Genres",
					value: "Adventure, Science Fiction",
				}),
			]),
		);
	});

	it("shows TV year and numbered-season count", () => {
		const tv: TvDetails = {
			...movie,
			mediaType: "tv",
			title: "Breaking Bad",
			year: 2008,
			runtimeMinutes: null,
			episodeRunTimeMinutes: 45,
			status: "Ended",
			seasons: [
				{ seasonNumber: 0, episodeCount: 7 },
				{ seasonNumber: 1, episodeCount: 7 },
				{ seasonNumber: 2, episodeCount: 13 },
			],
		};
		const embed = mediaDetailsEmbed(tv, "breaking bad");
		expect(embed.description).toContain("TV Series • 2008");
		expect(embed.fields).toContainEqual({
			name: "Seasons",
			value: "2",
			inline: true,
		});
	});

	it.each([
		["https://example.com/poster.jpg", null],
		["../poster.jpg", null],
		["/folder/poster.jpg", null],
		["/poster.svg", null],
		["/poster.jpg?token=x", null],
		[null, null],
	] as const)("omits malformed poster path %s", (path, expected) => {
		expect(tmdbPosterUrl(path)).toBe(expected);
	});

	it("accepts only a normalized TMDB poster path", () => {
		expect(tmdbPosterUrl("/abc-123_X.webp")).toBe(
			"https://image.tmdb.org/t/p/w500/abc-123_X.webp",
		);
	});

	it("validates link buttons and Discord component limits", () => {
		expect(
			button({
				label: "Download",
				style: BUTTON_LINK,
				url: "https://download.example/file",
			}),
		).toMatchObject({ style: 5, label: "Download" });
		expect(() =>
			button({
				label: "Download",
				style: BUTTON_LINK,
				url: "http://download.example/file",
			}),
		).toThrow("HTTPS");

		const duplicate = "tb:w:duplicate";
		expect(() =>
			validateMessagePayload({
				components: [
					actionRow(
						button({
							label: "One",
							style: BUTTON_PRIMARY,
							customId: duplicate,
						}),
						button({
							label: "Two",
							style: BUTTON_PRIMARY,
							customId: duplicate,
						}),
					),
				],
			}),
		).toThrow("duplicate");
	});
});
