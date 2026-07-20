/**
 * Formatting and sanitization helpers for Discord output.
 *
 * Discord message content is limited to 2000 characters, and messages sent
 * by this Worker always set `allowed_mentions: { parse: [] }` so nothing in
 * the content can ping users, roles, @everyone, or @here.
 */

/** Discord's hard limit for message content. */
export const DISCORD_CONTENT_LIMIT = 2000;

/** Replace C0 control characters and DEL with spaces (avoids raw escapes). */
function stripControlChars(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out += code < 32 || code === 127 ? " " : char;
	}
	return out;
}

/** Format a byte count as a human-readable binary size. */
export function formatBytes(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
		return "unknown size";
	}
	if (bytes === 0) {
		return "0 B";
	}
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** exponent;
	const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${units[exponent]}`;
}

/** Truncate text to `max` characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	if (max <= 1) {
		return "…";
	}
	return `${text.slice(0, max - 1)}…`;
}

/**
 * Make untrusted text safe for single-line inline-code display in Discord:
 * removes backticks (so it cannot break out of code formatting), collapses
 * all whitespace (including newlines) to single spaces, and strips control
 * characters. Mention pings are additionally neutralized at the message
 * level via `allowed_mentions: { parse: [] }`.
 */
export function sanitizeInline(text: string, maxLength = 150): string {
	const cleaned = stripControlChars(text)
		.replace(/`/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	return truncate(cleaned, maxLength);
}

/** Newznab/Torznab top-level category IDs. */
const CATEGORY_NAMES: Record<number, string> = {
	1000: "Console",
	2000: "Movies",
	3000: "Audio",
	4000: "PC",
	5000: "TV",
	6000: "XXX",
	7000: "Books",
	8000: "Other",
};

/** Map a numeric Torznab category id (e.g. 2040, 5030) to a readable name. */
export function categoryName(categoryId: number | null): string | null {
	if (categoryId === null || !Number.isFinite(categoryId)) {
		return null;
	}
	const topLevel = Math.floor(categoryId / 1000) * 1000;
	return CATEGORY_NAMES[topLevel] ?? null;
}
