import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { TorrentResult, TorznabItem } from "../types/torznab";
import {
	TorznabResponseError,
	UpstreamParseError,
	UpstreamStatusError,
} from "../utils/errors";
import { fetchText } from "../utils/http";
import { sanitizeInline } from "../utils/format";

/**
 * Typed adapter for the TorBox Voyager Torznab search endpoint.
 *
 * Verified against the live service (2026-07-19, see types/torznab.ts):
 * - Base URL: https://search-api.torbox.app
 * - `GET /torznab/api` requires `apikey` and `t` query params.
 * - `t=search&q=...` performs a free-text search; `o=xml` selects Torznab XML.
 * - 422 JSON validation error for missing params; 429 JSON for invalid keys.
 *
 * The exact success XML shape is not yet confirmed with a real key; parsing
 * targets the standard Newznab/Torznab RSS shape and treats every field as
 * optional so unknown or missing data degrades instead of throwing.
 */

export const VOYAGER_BASE_URL = "https://search-api.torbox.app";
const VOYAGER_SERVICE = "voyager" as const;
/** Never process more than this many <item> entries from one response. */
const MAX_PARSED_ITEMS = 50;

export interface VoyagerSearchOptions {
	apiKey: string;
	/** Override for tests. */
	baseUrl?: string;
	timeoutMs?: number;
}

/**
 * XML parser configuration. fast-xml-parser performs pure in-memory string
 * processing and never performs I/O, but it DOES expand internal entities
 * defined in a DOCTYPE; parseTorznabXml therefore rejects any document
 * containing a DOCTYPE before parsing, which closes off entity-expansion
 * (billion laughs) and external-entity attacks. `parseTagValue: false`
 * keeps every value a string so we control all number coercion.
 */
const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	removeNSPrefix: true,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	isArray: (tagName) => tagName === "item" || tagName === "attr",
});

interface RawAttr {
	"@_name"?: unknown;
	"@_value"?: unknown;
}

interface RawItem {
	title?: unknown;
	link?: unknown;
	guid?: unknown;
	pubDate?: unknown;
	size?: unknown;
	category?: unknown;
	jackettindexer?: unknown;
	enclosure?: { "@_url"?: unknown } | { "@_url"?: unknown }[];
	attr?: RawAttr[];
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	return undefined;
}

function asStringArray(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string");
	}
	return [];
}

function parsePositiveInt(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return null;
	}
	return parsed;
}

function normalizeItem(raw: RawItem): TorznabItem {
	const attributes: Record<string, string> = {};
	for (const attr of raw.attr ?? []) {
		const name = asString(attr["@_name"]);
		const value = asString(attr["@_value"]);
		if (name && value !== undefined && attributes[name] === undefined) {
			attributes[name] = value;
		}
	}

	const enclosures = Array.isArray(raw.enclosure)
		? raw.enclosure
		: raw.enclosure
			? [raw.enclosure]
			: [];
	const enclosureUrl = enclosures
		.map((entry) => asString(entry["@_url"]))
		.find((url): url is string => url !== undefined);

	return {
		title: asString(raw.title),
		link: asString(raw.link),
		guid: asString(raw.guid),
		pubDate: asString(raw.pubDate),
		size: asString(raw.size),
		category: asStringArray(raw.category),
		enclosureUrl,
		attributes,
		// Jackett-style indexers report the source as a dedicated element.
		indexerElement: asString(raw.jackettindexer),
	};
}

function toTorrentResult(item: TorznabItem): TorrentResult | null {
	const title = item.title?.trim();
	if (!title) {
		// A result without a title is useless for display; skip it.
		return null;
	}

	const attrs = item.attributes;
	const link = item.link ?? null;
	const magnetFromAttrs = attrs.magneturl ?? null;
	const magnetUri =
		magnetFromAttrs ??
		(link?.startsWith("magnet:") ? link : null) ??
		(item.enclosureUrl?.startsWith("magnet:") ? item.enclosureUrl : null);

	const categoryId =
		parsePositiveInt(attrs.category) ??
		parsePositiveInt(item.category?.[0]);

	return {
		title,
		sizeBytes: parsePositiveInt(attrs.size) ?? parsePositiveInt(item.size),
		seeders: parsePositiveInt(attrs.seeders),
		peers: parsePositiveInt(attrs.peers),
		categoryId,
		source: attrs.indexer ?? attrs.jackettindexer ?? item.indexerElement ?? null,
		link,
		infoHash: attrs.infohash ?? null,
		magnetUri,
		publishedAt: item.pubDate ?? null,
	};
}

/**
 * Parse a Torznab XML document into normalized results.
 * Throws TorznabResponseError for protocol-level <error> documents and
 * UpstreamParseError for malformed or unexpected XML.
 */
export function parseTorznabXml(xml: string): TorrentResult[] {
	// Reject DOCTYPE declarations outright: fast-xml-parser expands internal
	// entity definitions found in a DOCTYPE, so allowing it would open the
	// door to entity-expansion (billion laughs) and external-entity tricks.
	// Torznab feeds never require a DOCTYPE.
	if (/<!doctype/i.test(xml)) {
		throw new UpstreamParseError(
			VOYAGER_SERVICE,
			"returned XML with a forbidden DOCTYPE",
		);
	}

	if (XMLValidator.validate(xml) !== true) {
		throw new UpstreamParseError(VOYAGER_SERVICE, "returned malformed XML");
	}

	let document: unknown;
	try {
		document = xmlParser.parse(xml);
	} catch {
		throw new UpstreamParseError(VOYAGER_SERVICE, "returned malformed XML");
	}

	const root = document as {
		error?: { "@_code"?: unknown; "@_description"?: unknown };
		rss?: { channel?: { item?: RawItem[] } };
	};

	if (root && typeof root === "object" && root.error) {
		const description =
			sanitizeInline(asString(root.error["@_description"]) ?? "unknown error", 200);
		const code = asString(root.error["@_code"]) ?? null;
		throw new TorznabResponseError(
			`search service reported an error: ${description}`,
			code,
		);
	}

	const channel = root?.rss?.channel;
	if (!channel) {
		throw new UpstreamParseError(
			VOYAGER_SERVICE,
			"returned an unexpected XML structure",
		);
	}

	// A channel with no <item> elements is a valid empty result set.
	const items = channel.item ?? [];

	const results: TorrentResult[] = [];
	for (const rawItem of items.slice(0, MAX_PARSED_ITEMS)) {
		const result = toTorrentResult(normalizeItem(rawItem));
		if (result) {
			results.push(result);
		}
	}
	return results;
}

/**
 * Deterministic result ordering: seeders (desc), then size (desc), then
 * title (asc). Unknown values sort last.
 */
export function sortResults(results: readonly TorrentResult[]): TorrentResult[] {
	return results
		.map((result, index) => ({ result, index }))
		.sort((a, b) => {
			const seeders = (b.result.seeders ?? -1) - (a.result.seeders ?? -1);
			if (seeders !== 0) return seeders;
			const size = (b.result.sizeBytes ?? -1) - (a.result.sizeBytes ?? -1);
			if (size !== 0) return size;
			const title = a.result.title.localeCompare(b.result.title);
			if (title !== 0) return title;
			return a.index - b.index;
		})
		.map(({ result }) => result);
}

/**
 * Search Voyager for torrents matching `query`.
 *
 * Throws UpstreamTimeoutError, UpstreamNetworkError, UpstreamStatusError,
 * UpstreamParseError, or TorznabResponseError. Error messages never contain
 * the API key or the full request URL.
 */
export async function searchTorrents(
	query: string,
	options: VoyagerSearchOptions,
): Promise<TorrentResult[]> {
	const baseUrl = options.baseUrl ?? VOYAGER_BASE_URL;
	const url = new URL("/torznab/api", baseUrl);
	url.searchParams.set("t", "search");
	url.searchParams.set("q", query);
	url.searchParams.set("o", "xml");
	url.searchParams.set("apikey", options.apiKey);

	const { status, body } = await fetchText(url.toString(), {
		service: VOYAGER_SERVICE,
		timeoutMs: options.timeoutMs,
		headers: { accept: "application/rss+xml, application/xml, text/xml" },
	});

	if (status !== 200) {
		throw new UpstreamStatusError(VOYAGER_SERVICE, status);
	}

	return parseTorznabXml(body);
}
