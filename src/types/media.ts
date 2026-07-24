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
