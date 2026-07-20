/**
 * Types for the Voyager (TorBox) Torznab search endpoint.
 *
 * Verified against the live service on 2026-07-19:
 * - `GET https://search-api.torbox.app/torznab/api` (OpenAPI spec is public).
 * - Required query params: `apikey`, `t`. Optional: `q`, `season`, `ep`,
 *   `tvdbid`, `tvmazeid`, `tmdbid`, `imdbid`, `offset`, `o` (default "xml"),
 *   `check_cache`, `check_owned`, `search_user_engines`.
 * - Missing required params -> 422 JSON validation error.
 * - Invalid API key -> 429 JSON `{"error": "Rate limit exceeded: 0 per 1 minute"}`.
 *
 * NOT yet verified (requires a real API key): the exact success XML payload.
 * The parser targets the standard Newznab/Torznab RSS shape (rss > channel >
 * item, with `torznab:attr name=... value=...` extensions) and tolerates
 * missing optional fields. See README "External API assumptions".
 */

/** A normalized torrent search result. All upstream quirks are resolved. */
export interface TorrentResult {
	title: string;
	/** Total size in bytes, when provided by the indexer. */
	sizeBytes: number | null;
	seeders: number | null;
	peers: number | null;
	/** Raw numeric Torznab category id (e.g. 2040), first one when several. */
	categoryId: number | null;
	/** Indexer/tracker name when provided (e.g. via an `indexer` attribute). */
	source: string | null;
	/** Direct link reported by the indexer (download page or torrent file). */
	link: string | null;
	/** Info hash when provided via torznab attributes. */
	infoHash: string | null;
	/** Magnet URI when provided. Never displayed in Discord output. */
	magnetUri: string | null;
	/** Publication date as reported by the indexer (raw string). */
	publishedAt: string | null;
}

/** Raw shape produced by the tolerant XML normalization layer. */
export interface TorznabItem {
	title?: string;
	link?: string;
	guid?: string;
	pubDate?: string;
	size?: string;
	category?: string | string[];
	enclosureUrl?: string;
	/** Map of torznab:attr name -> value. Repeated names keep the first value. */
	attributes: Record<string, string>;
	/** Jackett-style <jackettindexer> element value, when present. */
	indexerElement?: string;
}
