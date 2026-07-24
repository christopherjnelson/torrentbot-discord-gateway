import type {
	DiscordInteraction,
	MessageComponent,
} from "../discord/types";
import type { TvDetails, TvSeasonSummary } from "../types/media";
import { sanitizeInline } from "../utils/format";
import {
	buildSeasonCustomId,
	createSeasonPayload,
	digestComponentQuery,
	DISCORD_ID_LIMIT,
	MAX_SELECT_OPTIONS,
	signPayload,
	verifySignature,
	type SeasonComponentPayload,
} from "../utils/signing";
import {
	escapeHeadingQuery,
	unescapeHeadingQuery,
} from "./media";

export const TV_SEASON_PAGE_SIZE = 20;
const DESCRIPTION_LIMIT = 100;
const VALUE_SIGNATURE_LENGTH = 22;
const ORIGINAL_QUERY_MARKER = "\nOriginal search: **";

type SeasonValueKind = "complete" | "season" | "exact" | "page";

type ParsedSeasonValue = {
	kind: SeasonValueKind;
	value: number;
	signature: string;
};

export type SeasonSelection =
	| { kind: "complete"; query: string }
	| { kind: "season"; seasonNumber: number; query: string }
	| { kind: "exact"; query: string }
	| { kind: "page"; page: number; query: string };

function optionSigningInput(
	kind: SeasonValueKind,
	value: number,
	payload: SeasonComponentPayload,
): string {
	return [
		kind,
		String(value),
		String(payload.seriesId),
		String(payload.page),
		payload.queryDigest,
	].join(":");
}

async function buildOptionValue(
	kind: SeasonValueKind,
	value: number,
	payload: SeasonComponentPayload,
	secret: string,
): Promise<string> {
	const signature = await signPayload(
		optionSigningInput(kind, value, payload),
		secret,
	);
	const code =
		kind === "complete"
			? "c"
			: kind === "season"
				? "s"
				: kind === "exact"
					? "x"
					: "p";
	const encoded = `${code}:${value}:${signature}`;
	if (encoded.length > DISCORD_ID_LIMIT) {
		throw new Error("season select option value exceeds Discord limit");
	}
	return encoded;
}

function parseOptionValue(raw: string): ParsedSeasonValue | null {
	const first = raw.indexOf(":");
	const second = raw.indexOf(":", first + 1);
	if (
		first !== 1 ||
		second <= first + 1 ||
		raw.length - second - 1 !== VALUE_SIGNATURE_LENGTH
	) {
		return null;
	}
	const code = raw.slice(0, first);
	const value = Number(raw.slice(first + 1, second));
	const signature = raw.slice(second + 1);
	if (
		!["c", "s", "x", "p"].includes(code) ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		!/^[A-Za-z0-9_-]{22}$/.test(signature)
	) {
		return null;
	}
	const kind: SeasonValueKind =
		code === "c"
			? "complete"
			: code === "s"
				? "season"
				: code === "x"
					? "exact"
					: "page";
	return { kind, value, signature };
}

function collectOptionValues(
	components: readonly MessageComponent[] | undefined,
): string[] {
	const values: string[] = [];
	for (const component of components ?? []) {
		for (const option of component.options ?? []) {
			values.push(option.value);
		}
		values.push(...collectOptionValues(component.components));
	}
	return values;
}

function queryFromSeasonHeading(content: string | undefined): string | null {
	if (
		content === undefined ||
		!content.startsWith("Choose what to download for **") ||
		!content.endsWith("**")
	) {
		return null;
	}
	const markerIndex = content.lastIndexOf(ORIGINAL_QUERY_MARKER);
	if (markerIndex < 0) {
		return null;
	}
	return unescapeHeadingQuery(
		content.slice(
			markerIndex + ORIGINAL_QUERY_MARKER.length,
			content.length - 2,
		),
	);
}

function formatSeasonCode(seasonNumber: number): string {
	return `S${String(seasonNumber).padStart(2, "0")}`;
}

function seasonDescription(season: TvSeasonSummary): string {
	const code = formatSeasonCode(season.seasonNumber);
	if (season.episodeCount === null) {
		return code;
	}
	const noun = season.episodeCount === 1 ? "episode" : "episodes";
	return `${code} • ${season.episodeCount} ${noun}`;
}

export function seasonPageCount(seasons: readonly TvSeasonSummary[]): number {
	return Math.max(1, Math.ceil(seasons.length / TV_SEASON_PAGE_SIZE));
}

export function formatSeasonHeading(
	title: string,
	originalQuery: string,
	hasSeasons: boolean,
): string {
	const safeTitle = escapeHeadingQuery(sanitizeInline(title, 100));
	const warning = hasSeasons
		? ""
		: "\n\nNo season information was available. Choose Complete series or search exactly as entered.";
	return (
		`Choose what to download for **${safeTitle}**:` +
		warning +
		`${ORIGINAL_QUERY_MARKER}${escapeHeadingQuery(originalQuery)}**`
	);
}

/**
 * Render one bounded page. Twenty season rows plus Complete, navigation, and
 * exact search never exceed Discord's 25-option select limit.
 */
export async function buildSeasonComponents(
	details: TvDetails,
	originalQuery: string,
	payload: SeasonComponentPayload,
	signingSecret: string,
): Promise<object[]> {
	const pageCount = seasonPageCount(details.seasons);
	if (
		payload.seriesId !== details.id ||
		!Number.isSafeInteger(payload.page) ||
		payload.page < 0 ||
		payload.page >= pageCount ||
		(await digestComponentQuery(originalQuery)) !== payload.queryDigest
	) {
		throw new Error("invalid season page state");
	}

	const pageStart = payload.page * TV_SEASON_PAGE_SIZE;
	const seasons = details.seasons.slice(
		pageStart,
		pageStart + TV_SEASON_PAGE_SIZE,
	);
	const options: Array<{
		label: string;
		value: string;
		description: string;
	}> = [];

	if (payload.page === 0) {
		options.push({
			label: "Complete series",
			value: await buildOptionValue(
				"complete",
				0,
				payload,
				signingSecret,
			),
			description: "All seasons",
		});
	}

	for (const season of seasons) {
		options.push({
			label:
				season.seasonNumber === 0
					? "Specials"
					: `Season ${season.seasonNumber}`,
			value: await buildOptionValue(
				"season",
				season.seasonNumber,
				payload,
				signingSecret,
			),
			description: sanitizeInline(
				seasonDescription(season),
				DESCRIPTION_LIMIT,
			),
		});
	}

	if (payload.page > 0) {
		options.push({
			label: "Previous seasons",
			value: await buildOptionValue(
				"page",
				payload.page - 1,
				payload,
				signingSecret,
			),
			description: `Show page ${payload.page} of ${pageCount}`,
		});
	}
	if (payload.page + 1 < pageCount) {
		options.push({
			label: "Next seasons",
			value: await buildOptionValue(
				"page",
				payload.page + 1,
				payload,
				signingSecret,
			),
			description: `Show page ${payload.page + 2} of ${pageCount}`,
		});
	}

	options.push({
		label: "Search exactly as entered",
		value: await buildOptionValue("exact", 0, payload, signingSecret),
		description: "Bypass season selection",
	});

	if (options.length > MAX_SELECT_OPTIONS) {
		throw new Error("too many season select options");
	}
	for (const option of options) {
		if (
			option.label.length === 0 ||
			option.label.length > DISCORD_ID_LIMIT ||
			option.value.length > DISCORD_ID_LIMIT ||
			option.description.length === 0 ||
			option.description.length > DESCRIPTION_LIMIT
		) {
			throw new Error("invalid season select option");
		}
	}

	const customId = await buildSeasonCustomId(payload, signingSecret);
	return [
		{
			type: 1,
			components: [
				{
					type: 3,
					custom_id: customId,
					placeholder: `Select a season (page ${payload.page + 1}/${pageCount})`,
					options,
				},
			],
		},
	];
}

export async function extractSeasonSelection(
	interaction: DiscordInteraction,
	payload: SeasonComponentPayload,
	signingSecret: string,
): Promise<SeasonSelection | null> {
	const selectedRaw =
		interaction.data && "values" in interaction.data
			? interaction.data.values?.[0]
			: undefined;
	if (
		!selectedRaw ||
		!interaction.data ||
		!("values" in interaction.data) ||
		interaction.data.values?.length !== 1
	) {
		return null;
	}

	const rawValues = collectOptionValues(interaction.message?.components);
	if (
		rawValues.length === 0 ||
		rawValues.length > MAX_SELECT_OPTIONS ||
		!rawValues.includes(selectedRaw)
	) {
		return null;
	}

	const selected = parseOptionValue(selectedRaw);
	if (
		!selected ||
		!(await verifySignature(
			optionSigningInput(selected.kind, selected.value, payload),
			selected.signature,
			signingSecret,
		))
	) {
		return null;
	}

	const query = queryFromSeasonHeading(interaction.message?.content);
	if (
		query === null ||
		query.length === 0 ||
		query.length > 200 ||
		query.trim() !== query ||
		(await digestComponentQuery(query)) !== payload.queryDigest
	) {
		return null;
	}

	if (selected.kind === "complete") {
		return selected.value === 0 ? { kind: "complete", query } : null;
	}
	if (selected.kind === "exact") {
		return selected.value === 0 ? { kind: "exact", query } : null;
	}
	if (selected.kind === "page") {
		return Math.abs(selected.value - payload.page) === 1
			? { kind: "page", page: selected.value, query }
			: null;
	}
	return {
		kind: "season",
		seasonNumber: selected.value,
		query,
	};
}

/**
 * Construct the canonical TV query. A trusted title is still normalized
 * defensively; year, TMDB ID, episode count, and media labels are never added.
 */
export function buildTvSeasonQuery(
	title: string,
	selection: "complete" | number,
): string | null {
	let normalizedTitle = "";
	for (const character of title) {
		const code = character.codePointAt(0) ?? 0;
		normalizedTitle += code < 32 || code === 127 ? " " : character;
	}
	normalizedTitle = normalizedTitle.replace(/\s+/g, " ").trim();
	if (normalizedTitle.length === 0) {
		return null;
	}
	if (selection === "complete") {
		return `${normalizedTitle} complete`;
	}
	if (!Number.isSafeInteger(selection) || selection < 0) {
		return null;
	}
	return `${normalizedTitle} ${formatSeasonCode(selection)}`;
}

export function nextSeasonPayload(
	payload: SeasonComponentPayload,
	page: number,
): SeasonComponentPayload {
	return createSeasonPayload(
		payload.userId,
		payload.seriesId,
		page,
		payload.queryDigest,
		payload.expiry,
	);
}
