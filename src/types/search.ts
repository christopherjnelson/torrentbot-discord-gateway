/**
 * Normalized torrent search result shared by the Discord `/search` command
 * and the internal `/api/search` route. Search backends (currently Prowlarr)
 * resolve all upstream quirks into this shape.
 */

/** A normalized torrent search result. All upstream quirks are resolved. */
export interface TorrentResult {
	title: string;
	/** Total size in bytes, when provided by the indexer. */
	sizeBytes: number | null;
	seeders: number | null;
	/** Total swarm size (seeders + leechers) when both are known. */
	peers: number | null;
	/** Raw numeric Newznab category id (e.g. 2040), first one when several. */
	categoryId: number | null;
	/** Indexer/tracker name (e.g. Prowlarr's `indexer` field). */
	source: string | null;
	/** Details page URL reported by the indexer (never a credential-bearing
	 * download/proxy URL). */
	link: string | null;
	/** Info hash when provided by the backend. */
	infoHash: string | null;
	/** Magnet URI (raw or synthesized from the info hash). Never displayed
	 * in Discord output. */
	magnetUri: string | null;
	/** Publication date as reported by the backend (raw string). */
	publishedAt: string | null;
	/**
	 * Advisory TorBox cache availability for this result's info hash, set
	 * by the `/search` flow after a best-effort batch cache check. True
	 * only when TorBox reports the hash as cached; undefined for uncached,
	 * unknown, or unchecked results. Never populated by search backends.
	 */
	isCached?: boolean;
}
