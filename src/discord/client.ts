import { fetchText } from "../utils/http";

/**
 * Minimal Discord REST client for interaction follow-ups.
 *
 * Follow-up webhook endpoints authenticate with the interaction token itself
 * (no bot token required). The token is valid for 15 minutes.
 *
 * Security notes:
 * - The interaction token is embedded in request URLs only; it is never
 *   logged, and upstream error types never carry URLs.
 * - Only message `content` is sent; no embeds, no attachments.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface FollowupMessage {
	content: string;
	components?: object[];
}

/**
 * Normalized Discord API failure. Carries only fields safe to log:
 * the HTTP status, Discord's numeric error `code` (if present), a sanitized
 * message, and sanitized field-error paths. It never carries the webhook
 * URL, interaction token, custom IDs, option values, API keys, magnets, or
 * the full request payload.
 */
export class DiscordApiError extends Error {
	readonly status: number;
	readonly code: number | null;
	readonly discordMessage: string | null;
	readonly fieldErrors: string[];

	constructor(params: {
		status: number;
		code?: number | null;
		message?: string | null;
		fieldErrors?: string[];
	}) {
		super(`discord edit failed (HTTP ${params.status})`);
		this.name = "DiscordApiError";
		this.status = params.status;
		this.code = params.code ?? null;
		this.discordMessage = params.message ?? null;
		this.fieldErrors = params.fieldErrors ?? [];
	}
}

/** Keep only printable ASCII word/dot characters for field-error paths. */
function sanitizeFieldPath(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 64);
}

interface DiscordErrorBody {
	code?: number;
	message?: string;
	errors?: Record<string, unknown>;
}

/**
 * Recursively collect Discord field-error paths (e.g. `data.components[0]`)
 * without including the offending values.
 */
function collectFieldErrors(errors: unknown, prefix = ""): string[] {
	if (!errors || typeof errors !== "object") {
		return [];
	}
	const out: string[] = [];
	for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === "object" && "_errors" in (value as object)) {
			out.push(sanitizeFieldPath(path));
			continue;
		}
		if (value && typeof value === "object") {
			out.push(...collectFieldErrors(value, path));
		}
	}
	return out;
}

/** Parse a Discord JSON error body into safe, sanitized fields only. */
function parseDiscordError(body: string): {
	code: number | null;
	message: string | null;
	fieldErrors: string[];
} {
	let parsed: DiscordErrorBody | null = null;
	try {
		parsed = JSON.parse(body) as DiscordErrorBody;
	} catch {
		return { code: null, message: null, fieldErrors: [] };
	}
	const code = typeof parsed.code === "number" ? parsed.code : null;
	const message =
		typeof parsed.message === "string" ? parsed.message.slice(0, 200) : null;
	const fieldErrors = collectFieldErrors(parsed.errors);
	return { code, message, fieldErrors };
}

/**
 * Edit the original response to an interaction (used after a deferred ACK).
 * PATCH /webhooks/{application.id}/{interaction.token}/messages/@original
 *
 * Throws a `DiscordApiError` carrying only sanitized diagnostic fields.
 */
export async function editOriginalResponse(
	applicationId: string,
	interactionToken: string,
	message: FollowupMessage,
	timeoutMs?: number,
): Promise<void> {
	const url =
		`${DISCORD_API_BASE}/webhooks/${applicationId}` +
		`/${interactionToken}/messages/@original`;

	const body: Record<string, unknown> = {
		content: message.content,
		allowed_mentions: { parse: [] },
	};
	if (message.components) {
		body.components = message.components;
	}

	const { status, body: responseBody } = await fetchText(url, {
		service: "discord",
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs,
	});

	if (status < 200 || status >= 300) {
		const { code, message, fieldErrors } = parseDiscordError(responseBody);
		throw new DiscordApiError({
			status,
			code,
			message,
			fieldErrors,
		});
	}
}
