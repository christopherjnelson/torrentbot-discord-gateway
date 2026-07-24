/** Media kinds supported by the repository's TMDB integration. */
export type MediaType = "movie" | "tv";

/**
 * Small normalized TMDB shape used for both search choices and details.
 * No images, descriptions, genres, or other unrelated provider fields cross
 * the service boundary.
 */
export interface MediaSearchResult {
	id: number;
	mediaType: MediaType;
	title: string;
	originalTitle: string | null;
	year: number | null;
	popularity: number | null;
}

/** Trusted, normalized season metadata returned with TMDB TV details. */
export interface TvSeasonSummary {
	seasonNumber: number;
	episodeCount: number | null;
}

/** Trusted, bounded metadata displayed on a selected-media card. */
export interface MediaDetails extends MediaSearchResult {
	overview: string | null;
	posterPath: string | null;
	genres: readonly string[];
	runtimeMinutes: number | null;
	episodeRunTimeMinutes: number | null;
	status: string | null;
}

/** TV details add the season fields needed by the selection workflow. */
export interface TvDetails extends MediaDetails {
	mediaType: "tv";
	seasons: readonly TvSeasonSummary[];
}
