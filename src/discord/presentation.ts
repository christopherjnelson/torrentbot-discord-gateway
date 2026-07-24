import type { MediaDetails, TvDetails } from "../types/media";
import type { TorrentResult } from "../types/search";
import { formatBytes, sanitizeInline, truncate } from "../utils/format";
import { escapeHeadingQuery, unescapeHeadingQuery } from "../commands/media";

export const BUTTON_PRIMARY = 1;
export const BUTTON_SECONDARY = 2;
export const BUTTON_DANGER = 4;
export const BUTTON_LINK = 5;

export const EMBED_TITLE_LIMIT = 256;
export const EMBED_DESCRIPTION_LIMIT = 4_096;
export const EMBED_FIELD_VALUE_LIMIT = 1_024;
export const EMBED_FOOTER_LIMIT = 2_048;
export const MESSAGE_CONTENT_LIMIT = 2_000;
export const MAX_ACTION_ROWS = 5;
export const MAX_COMPONENTS_PER_ROW = 5;
export const MEDIA_OVERVIEW_LIMIT = 420;

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const POSTER_PATH_PATTERN = /^\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i;
const QUERY_FOOTER_PREFIX = "Original search: ";

export interface DiscordEmbed {
	title?: string;
	description?: string;
	color?: number;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	thumbnail?: { url: string };
	footer?: { text: string };
}

export interface DiscordMessagePayload {
	content?: string;
	embeds?: DiscordEmbed[];
	components?: object[];
}

export function tmdbPosterUrl(posterPath: string | null): string | null {
	if (!posterPath || !POSTER_PATH_PATTERN.test(posterPath)) {
		return null;
	}
	const url = new URL(`${TMDB_IMAGE_BASE}${posterPath}`);
	return url.protocol === "https:" &&
		url.origin === "https://image.tmdb.org"
		? url.toString()
		: null;
}

export function queryFooter(query: string): { text: string } {
	return {
		text: truncate(
			`${QUERY_FOOTER_PREFIX}${escapeHeadingQuery(query)}`,
			EMBED_FOOTER_LIMIT,
		),
	};
}

export function queryFromFooter(
	embeds: readonly { footer?: { text?: string } }[] | undefined,
): string | null {
	const text = embeds?.[0]?.footer?.text;
	if (!text?.startsWith(QUERY_FOOTER_PREFIX)) {
		return null;
	}
	return unescapeHeadingQuery(text.slice(QUERY_FOOTER_PREFIX.length));
}

function mediaTypeLine(details: MediaDetails): string {
	return `${details.mediaType === "movie" ? "Movie" : "TV Series"} • ${
		details.year ?? "Year unknown"
	}`;
}

function metadataFields(details: MediaDetails): DiscordEmbed["fields"] {
	const fields: NonNullable<DiscordEmbed["fields"]> = [];
	const runtime =
		details.mediaType === "movie"
			? details.runtimeMinutes
			: details.episodeRunTimeMinutes;
	if (runtime !== null) {
		fields.push({ name: "Runtime", value: `${runtime} min`, inline: true });
	}
	if (details.genres.length > 0) {
		fields.push({
			name: "Genres",
			value: truncate(
				details.genres.map((genre) => sanitizeInline(genre, 50)).join(", "),
				EMBED_FIELD_VALUE_LIMIT,
			),
			inline: true,
		});
	}
	if (details.status) {
		fields.push({
			name: "Status",
			value: sanitizeInline(details.status, 80),
			inline: true,
		});
	}
	return fields;
}

export function mediaDetailsEmbed(
	details: MediaDetails,
	originalQuery: string,
	options: {
		step: string;
		selectedSeason?: number | "complete";
	} = { step: "Media selected" },
): DiscordEmbed {
	const fields = metadataFields(details) ?? [];
	if ("seasons" in details) {
		const numbered = (details as TvDetails).seasons.filter(
			(season) => season.seasonNumber > 0,
		).length;
		fields.unshift({
			name: "Seasons",
			value: String(numbered),
			inline: true,
		});
	}
	if (options.selectedSeason !== undefined) {
		fields.unshift({
			name: "Selection",
			value:
				options.selectedSeason === "complete"
					? "Complete series"
					: options.selectedSeason === 0
						? "Specials • S00"
						: `Season ${options.selectedSeason} • S${String(
								options.selectedSeason,
							).padStart(2, "0")}`,
			inline: false,
		});
	}
	fields.push({
		name: "Step",
		value: sanitizeInline(options.step, 100),
		inline: false,
	});
	const poster = tmdbPosterUrl(details.posterPath);
	return {
		title: sanitizeInline(details.title, EMBED_TITLE_LIMIT),
		description: truncate(
			[
				mediaTypeLine(details),
				details.overview
					? `\n${sanitizeInline(details.overview, MEDIA_OVERVIEW_LIMIT)}`
					: "",
			].join(""),
			EMBED_DESCRIPTION_LIMIT,
		),
		color: 0x5865f2,
		fields,
		...(poster ? { thumbnail: { url: poster } } : {}),
		footer: queryFooter(originalQuery),
	};
}

export function releaseSelectionEmbed(
	label: string,
	query: string,
	results: readonly TorrentResult[],
	originalQuery: string,
): DiscordEmbed {
	const cached = results.filter((result) => result.isCached).length;
	return {
		title: truncate(label || "Release selection", EMBED_TITLE_LIMIT),
		description: `Choose a release from the menu below.\n\nSearch: \`${sanitizeInline(
			query,
			180,
		)}\``,
		color: 0x5865f2,
		fields: [
			{
				name: "Available",
				value: `${results.length} release${results.length === 1 ? "" : "s"}`,
				inline: true,
			},
			{
				name: "TorBox cache",
				value: cached > 0 ? `${cached} cached` : "No cached matches",
				inline: true,
			},
			{ name: "Step", value: "Select a release", inline: false },
		],
		footer: queryFooter(originalQuery),
	};
}

export function statusEmbed(
	title: string,
	status: string,
	options: {
		description?: string;
		progress?: number | null;
		color?: number;
	} = {},
): DiscordEmbed {
	const fields: NonNullable<DiscordEmbed["fields"]> = [
		{ name: "Status", value: sanitizeInline(status, 100), inline: true },
	];
	if (options.progress !== undefined && options.progress !== null) {
		fields.push({
			name: "Progress",
			value: `${Math.max(0, Math.min(100, Math.round(options.progress)))}%`,
			inline: true,
		});
	}
	return {
		title: truncate(sanitizeInline(title, EMBED_TITLE_LIMIT), EMBED_TITLE_LIMIT),
		description: options.description
			? truncate(
					sanitizeInline(options.description, EMBED_DESCRIPTION_LIMIT),
					EMBED_DESCRIPTION_LIMIT,
				)
			: undefined,
		color: options.color ?? 0xfee75c,
		fields,
	};
}

export function errorEmbed(title: string, message: string): DiscordEmbed {
	return {
		title: sanitizeInline(title, EMBED_TITLE_LIMIT),
		description: truncate(
			sanitizeInline(message, EMBED_DESCRIPTION_LIMIT),
			EMBED_DESCRIPTION_LIMIT,
		),
		color: 0xed4245,
	};
}

export function button(params: {
	label: string;
	style: number;
	customId?: string;
	url?: string;
	disabled?: boolean;
}): object {
	const label = sanitizeInline(params.label, 80);
	if (params.style === BUTTON_LINK) {
		if (!params.url) {
			throw new Error("link button URL is required");
		}
		const parsed = new URL(params.url);
		if (parsed.protocol !== "https:") {
			throw new Error("link button URL must use HTTPS");
		}
		return { type: 2, style: BUTTON_LINK, label, url: parsed.toString() };
	}
	if (!params.customId || params.customId.length > 100) {
		throw new Error("button custom_id is invalid");
	}
	return {
		type: 2,
		style: params.style,
		label,
		custom_id: params.customId,
		...(params.disabled ? { disabled: true } : {}),
	};
}

export function actionRow(...components: object[]): object {
	if (
		components.length === 0 ||
		components.length > MAX_COMPONENTS_PER_ROW
	) {
		throw new Error("invalid action row component count");
	}
	return { type: 1, components };
}

export function validateMessagePayload(payload: DiscordMessagePayload): void {
	if ((payload.content?.length ?? 0) > MESSAGE_CONTENT_LIMIT) {
		throw new Error("message content exceeds Discord limit");
	}
	if ((payload.components?.length ?? 0) > MAX_ACTION_ROWS) {
		throw new Error("message has too many action rows");
	}
	const customIds = new Set<string>();
	for (const row of payload.components ?? []) {
		const components =
			typeof row === "object" &&
			row !== null &&
			"components" in row &&
			Array.isArray((row as { components?: unknown }).components)
				? (row as { components: Array<Record<string, unknown>> }).components
				: [];
		if (
			components.length === 0 ||
			components.length > MAX_COMPONENTS_PER_ROW
		) {
			throw new Error("invalid action row component count");
		}
		for (const component of components) {
			if (
				Array.isArray(component.options) &&
				component.options.length > 25
			) {
				throw new Error("select has too many options");
			}
			if (typeof component.custom_id === "string") {
				if (component.custom_id.length > 100) {
					throw new Error("component custom_id exceeds Discord limit");
				}
				if (customIds.has(component.custom_id)) {
					throw new Error("duplicate component custom_id");
				}
				customIds.add(component.custom_id);
			}
		}
	}
	for (const embed of payload.embeds ?? []) {
		if ((embed.title?.length ?? 0) > EMBED_TITLE_LIMIT) {
			throw new Error("embed title exceeds Discord limit");
		}
		if ((embed.description?.length ?? 0) > EMBED_DESCRIPTION_LIMIT) {
			throw new Error("embed description exceeds Discord limit");
		}
		if ((embed.footer?.text.length ?? 0) > EMBED_FOOTER_LIMIT) {
			throw new Error("embed footer exceeds Discord limit");
		}
		for (const field of embed.fields ?? []) {
			if (field.value.length > EMBED_FIELD_VALUE_LIMIT) {
				throw new Error("embed field exceeds Discord limit");
			}
		}
	}
}

export function releaseOptionDescription(result: TorrentResult): string {
	const parts: string[] = [];
	if (result.isCached) parts.push("⚡ Cached");
	if (result.sizeBytes !== null && result.sizeBytes >= 0) {
		parts.push(formatBytes(result.sizeBytes));
	}
	if (result.seeders !== null) parts.push(`${result.seeders} seeds`);
	if (result.source) parts.push(sanitizeInline(result.source, 30));
	return truncate(parts.join(" • "), 100);
}
