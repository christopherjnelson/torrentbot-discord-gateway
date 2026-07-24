import type {
	DiscordInteraction,
	MessageComponent,
} from "../discord/types";
import type { MediaSearchResult, MediaType } from "../types/media";
import { sanitizeInline } from "../utils/format";
import {
	buildMediaCustomId,
	buildWorkflowCustomId,
	createMediaPayload,
	createWorkflowPayload,
	digestComponentQuery,
	DISCORD_ID_LIMIT,
	MAX_SELECT_OPTIONS,
	signPayload,
	verifySignature,
	type MediaComponentPayload,
} from "../utils/signing";

export const TMDB_MENU_RESULT_CAP = 10;
const MEDIA_DESCRIPTION_LIMIT = 100;
const VALUE_SIGNATURE_LENGTH = 22;

type ParsedMediaValue = {
	kind: "media" | "fallback";
	id: number;
	signature: string;
	raw: string;
};

export type MediaSelection =
	| { kind: "media"; id: number; query: string }
	| { kind: "fallback"; query: string };

function mediaLabel(mediaType: MediaType): string {
	return mediaType === "movie" ? "Movie" : "TV";
}

function valueSigningInput(
	kind: "media" | "fallback",
	id: number,
	queryDigest: string,
): string {
	return `${kind}:${id}:${queryDigest}`;
}

async function buildOptionValue(
	kind: "media" | "fallback",
	id: number,
	queryDigest: string,
	secret: string,
): Promise<string> {
	const signature = await signPayload(
		valueSigningInput(kind, id, queryDigest),
		secret,
	);
	const code = kind === "media" ? "m" : "x";
	const value = `${code}:${id}:${signature}`;
	if (value.length > DISCORD_ID_LIMIT) {
		throw new Error("media select option value exceeds Discord limit");
	}
	return value;
}

function parseOptionValue(raw: string): ParsedMediaValue | null {
	const first = raw.indexOf(":");
	const second = raw.indexOf(":", first + 1);
	if (
		first <= 0 ||
		second <= first + 1 ||
		raw.length - second - 1 !== VALUE_SIGNATURE_LENGTH
	) {
		return null;
	}
	const code = raw.slice(0, first);
	const id = Number(raw.slice(first + 1, second));
	const signature = raw.slice(second + 1);
	if (
		(code !== "m" && code !== "x") ||
		!Number.isSafeInteger(id) ||
		id < 0 ||
		!/^[A-Za-z0-9_-]{22}$/.test(signature)
	) {
		return null;
	}
	return {
		kind: code === "m" ? "media" : "fallback",
		id,
		signature,
		raw,
	};
}

export function escapeHeadingQuery(query: string): string {
	let output = "";
	for (const character of query) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\\" || character === "*") {
			output += `\\${character}`;
		} else if (code < 32 || code === 127) {
			output += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			output += character;
		}
	}
	return output;
}

export function unescapeHeadingQuery(value: string): string | null {
	let output = "";
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== "\\") {
			output += value[index];
			continue;
		}
		const next = value[index + 1];
		if (next === "\\" || next === "*") {
			output += next;
			index++;
			continue;
		}
		if (
			next === "u" &&
			/^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))
		) {
			output += String.fromCharCode(
				Number.parseInt(value.slice(index + 2, index + 6), 16),
			);
			index += 5;
			continue;
		}
		return null;
	}
	return output;
}

export function formatMediaHeading(
	mediaType: MediaType,
	query: string,
): string {
	const noun = mediaType === "movie" ? "movie" : "TV series";
	return `Choose a ${noun} for **${escapeHeadingQuery(query)}**:`;
}

function queryFromHeading(
	mediaType: MediaType,
	content: string | undefined,
): string | null {
	if (content === undefined) {
		return null;
	}
	const prefix =
		mediaType === "movie"
			? "Choose a movie for **"
			: "Choose a TV series for **";
	const suffix = "**:";
	if (!content.startsWith(prefix) || !content.endsWith(suffix)) {
		return null;
	}
	return unescapeHeadingQuery(
		content.slice(prefix.length, content.length - suffix.length),
	);
}

function collectOptionValues(
	components: readonly MessageComponent[] | undefined,
): string[] {
	const values: string[] = [];
	for (const component of components ?? []) {
		if (typeof component.value === "string") {
			values.push(component.value);
		}
		for (const option of component.options ?? []) {
			values.push(option.value);
		}
		values.push(...collectOptionValues(component.components));
	}
	return values;
}

/** Build a requester-bound TMDB disambiguation menu plus exact-query fallback. */
export async function buildMediaComponents(
	results: readonly MediaSearchResult[],
	mediaType: MediaType,
	query: string,
	userId: string,
	signingSecret: string,
): Promise<object[]> {
	const bounded = results
		.filter(
			(result) =>
				result.mediaType === mediaType &&
				sanitizeInline(result.title, 100).length > 0,
		)
		.slice(0, TMDB_MENU_RESULT_CAP);
	const optionCount = bounded.length;
	if (optionCount > MAX_SELECT_OPTIONS) {
		throw new Error("too many media select options");
	}
	const queryDigest = await digestComponentQuery(query);
	const options: Array<{
		label: string;
		value: string;
		description: string;
	}> = [];

	for (const result of bounded) {
		const label = sanitizeInline(result.title, 100);
		options.push({
			label,
			value: await buildOptionValue(
				"media",
				result.id,
				queryDigest,
				signingSecret,
			),
			description: sanitizeInline(
				`${result.year ?? "Year unknown"} • ${mediaLabel(mediaType)}`,
				MEDIA_DESCRIPTION_LIMIT,
			),
		});
	}

	const mediaPayload = createMediaPayload(userId, mediaType, queryDigest);
	const customId = await buildMediaCustomId(
		mediaPayload,
		signingSecret,
	);
	const exactId = await buildWorkflowCustomId(
		createWorkflowPayload({
			userId,
			action: "exact",
			mediaType,
			queryDigest,
			expiry: mediaPayload.expiry,
		}),
		signingSecret,
	);
	const cancelId = await buildWorkflowCustomId(
		createWorkflowPayload({
			userId,
			action: "cancel",
			mediaType,
			queryDigest,
			expiry: mediaPayload.expiry,
		}),
		signingSecret,
	);
	return [
		{
			type: 1,
			components: [
				{
					type: 3,
					custom_id: customId,
					placeholder:
						mediaType === "movie"
							? "Select a movie"
							: "Select a TV series",
					options,
				},
			],
		},
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 2,
					label: "Search Exactly as Entered",
					custom_id: exactId,
				},
				{
					type: 2,
					style: 4,
					label: "Cancel",
					custom_id: cancelId,
				},
			],
		},
	];
}

/**
 * Verify a selected media option and reconstruct the exact original query
 * from the bot-authored heading's reversible escaping. The interaction is
 * Discord-signed; the signed query digest and option HMAC additionally bind
 * it to this requester-bound, expiring menu.
 */
export async function extractMediaSelection(
	interaction: DiscordInteraction,
	payload: MediaComponentPayload,
	signingSecret: string,
): Promise<MediaSelection | null> {
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
		rawValues.length > TMDB_MENU_RESULT_CAP + 1 ||
		!rawValues.includes(selectedRaw)
	) {
		return null;
	}

	const selected = parseOptionValue(selectedRaw);
	if (
		!selected ||
		!(await verifySignature(
			valueSigningInput(
				selected.kind,
				selected.id,
				payload.queryDigest,
			),
			selected.signature,
			signingSecret,
		))
	) {
		return null;
	}
	const query = queryFromHeading(payload.mediaType, interaction.message?.content);
	if (
		query === null ||
		query.length === 0 ||
		query.length > 200 ||
		query.trim() !== query ||
		(await digestComponentQuery(query)) !== payload.queryDigest
	) {
		return null;
	}

	if (selected.kind === "fallback") {
		return selected.id === 0 ? { kind: "fallback", query } : null;
	}
	return selected.id > 0 ? { kind: "media", id: selected.id, query } : null;
}
