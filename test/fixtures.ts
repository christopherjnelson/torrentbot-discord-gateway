/**
 * Prowlarr `GET /api/v1/search` fixtures matching the verified
 * ReleaseResource shape (see src/services/prowlarr.ts).
 *
 * The fixtures deliberately use Prowlarr's real proxy-URL behavior for
 * `downloadUrl`/`magnetUrl` (`/{indexerId}/download?apikey=...&link=...`):
 * tests assert those credential-bearing URLs are never propagated.
 */
export const PROWLARR_TWO_ITEM_JSON = JSON.stringify([
	{
		guid: "https://indexer.example/details/aaa",
		title: "Blade.Runner.1982.Final.Cut.2160p.UHD.BluRay.x265-GRP",
		size: 26843545600,
		files: 1,
		grabs: 12,
		indexerId: 1,
		indexer: "ExampleTracker",
		publishDate: "2025-02-01T12:00:00Z",
		downloadUrl:
			"https://prowlarr.test/1/download?apikey=secret-prowlarr-key&link=AAA&file=t",
		magnetUrl:
			"https://prowlarr.test/1/download?apikey=secret-prowlarr-key&link=AAA&file=t",
		infoUrl: "https://indexer.example/details/aaa",
		infoHash: "0123456789ABCDEF0123456789ABCDEF01234567",
		seeders: 34,
		leechers: 6,
		protocol: "torrent",
		categories: [{ id: 2040, name: "Movies HD" }],
		indexerFlags: ["freeleech"],
	},
	{
		guid: "https://indexer.example/details/bbb",
		title: "Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-GRP",
		size: 1468006400,
		indexerId: 2,
		indexer: "ExampleTracker",
		publishDate: "2025-02-02T08:30:00Z",
		downloadUrl:
			"https://prowlarr.test/2/download?apikey=secret-prowlarr-key&link=BBB&file=t",
		magnetUrl:
			"https://prowlarr.test/2/download?apikey=secret-prowlarr-key&link=BBB&file=t",
		infoUrl: "https://indexer.example/details/bbb",
		infoHash: "89abcdef012345670123456789abcdef01234567",
		seeders: 120,
		leechers: 20,
		protocol: "torrent",
		categories: [{ id: 2030, name: "Movies HD" }],
		indexerFlags: [],
	},
]);

export const PROWLARR_EMPTY_JSON = "[]";
