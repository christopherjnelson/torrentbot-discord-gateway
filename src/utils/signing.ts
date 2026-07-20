/**
 * Stateless component payload signing using HMAC-SHA-256.
 *
 * Discord component `custom_id` and select option `value`/`label` fields are
 * capped at 100 characters, so the signed payload is kept compact:
 *   tb:a:<userId>:<expiry_seconds>:<signature>
 *
 * `expiry` is a Unix timestamp in seconds. The signature is a 16-byte
 * HMAC-SHA-256 truncated MAC encoded as base64url without padding (~22
 * characters), which keeps realistic 18-20 digit user IDs well under the
 * 100-character limit.
 *
 * Security properties:
 * - HMAC-SHA-256 via Web Crypto (available in Cloudflare Workers).
 * - Constant-time signature comparison.
 * - Optional expiry (10-15 minute window recommended).
 * - Payload does not contain API keys, tokens, or full magnet URIs.
 */

/** Short prefix for the compact custom_id format. */
export const CUSTOM_ID_PREFIX = "tb:a:";
export const SEPARATOR = ":";
export const EXPIRY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Number of MAC bytes to keep; 16 bytes -> 22 base64url chars. */
const SIGNATURE_BYTES = 16;
/** Estimated worst case signature length for length invariant checks. */
const SIGNATURE_LENGTH = 22;

/** Discord's hard limit for custom_id, option value, and option label. */
export const DISCORD_ID_LIMIT = 100;

/** Max options allowed by Discord for a string select. */
export const MAX_SELECT_OPTIONS = 25;
/** Max options used by this feature's select menu. */
export const SELECT_OPTION_CAP = 5;

export interface ComponentPayload {
	userId: string;
	infoHash: string;
	expiry: number;
}

/**
 * Build the plaintext payload string from a ComponentPayload.
 * Format: <userId><SEPARATOR><expiry_seconds>
 *
 * The info hash is intentionally omitted from the signed payload: it is
 * carried verbatim as the option `value` and validated separately, so it
 * does not need to inflate the compact custom_id.
 */
export function encodePayload(payload: ComponentPayload): string {
	const expirySeconds = Math.floor(payload.expiry / 1000);
	return `${payload.userId}${SEPARATOR}${expirySeconds}`;
}

/**
 * Parse a plaintext payload string. Returns null if malformed.
 * The info hash is restored from the caller's context (option value),
 * so it is left empty here.
 */
export function decodePayload(raw: string): ComponentPayload | null {
	const parts = raw.split(SEPARATOR);
	if (parts.length !== 2) {
		return null;
	}
	const [userId, expiryStr] = parts;
	const expiry = Number(expiryStr);
	if (
		!userId ||
		!Number.isFinite(expiry) ||
		!Number.isInteger(expiry) ||
		expiry <= 0
	) {
		return null;
	}
	return { userId, infoHash: "", expiry: expiry * 1000 };
}

/** Encode raw bytes as base64url without padding. */
export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	const b64 = btoa(binary);
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign a payload using HMAC-SHA-256, truncate the MAC to 16 bytes, and
 * return it base64url-encoded without padding.
 */
export async function signPayload(
	payload: string,
	secret: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(payload),
	);
	const full = new Uint8Array(signature).slice(0, SIGNATURE_BYTES);
	return base64url(full);
}

/**
 * Verify a payload against a base64url signature using constant-time
 * comparison.
 */
export async function verifySignature(
	payload: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	const expected = await signPayload(payload, secret);
	const expectedBytes = new TextEncoder().encode(expected);
	const actualBytes = new TextEncoder().encode(signature);
	if (expectedBytes.length !== actualBytes.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < expectedBytes.length; i++) {
		diff |= expectedBytes[i] ^ actualBytes[i];
	}
	return diff === 0;
}

/**
 * Build a full custom_id for a select menu.
 * Format: tb:a:<userId>:<expiry_seconds>:<signature>
 */
export async function buildCustomId(
	payload: ComponentPayload,
	secret: string,
): Promise<string> {
	const encoded = encodePayload(payload);
	const signature = await signPayload(encoded, secret);
	const customId = `${CUSTOM_ID_PREFIX}${encoded}${SEPARATOR}${signature}`;
	// Fail-safe: never emit an oversized custom_id to Discord.
	if (customId.length > DISCORD_ID_LIMIT) {
		throw new Error("generated custom_id exceeds Discord 100-char limit");
	}
	return customId;
}

/**
 * Parse and verify a custom_id from a Discord component interaction.
 * Returns null if the format is wrong, the prefix doesn't match, the
 * signature is invalid, or the payload has expired.
 */
export async function parseAndVerifyCustomId(
	customId: string,
	secret: string,
): Promise<ComponentPayload | null> {
	if (!customId.startsWith(CUSTOM_ID_PREFIX)) {
		return null;
	}
	const signedPart = customId.slice(CUSTOM_ID_PREFIX.length);
	const lastSep = signedPart.lastIndexOf(SEPARATOR);
	if (lastSep === -1) {
		return null;
	}
	const payload = signedPart.slice(0, lastSep);
	const signature = signedPart.slice(lastSep + 1);
	if (!payload || !signature) {
		return null;
	}
	const valid = await verifySignature(payload, signature, secret);
	if (!valid) {
		return null;
	}
	const parsed = decodePayload(payload);
	if (!parsed) {
		return null;
	}
	const now = Date.now();
	if (parsed.expiry < now) {
		return null; // expired
	}
	return parsed;
}

/** Create a payload that expires in 15 minutes. */
export function createPayload(
	userId: string,
	infoHash: string,
): ComponentPayload {
	return {
		userId,
		infoHash,
		expiry: Date.now() + EXPIRY_WINDOW_MS,
	};
}

/** Check if an info hash is a valid BitTorrent v1 hash (40 hex chars). */
export function isValidInfoHash(hash: string): boolean {
	return /^[a-fA-F0-9]{40}$/.test(hash);
}

/**
 * Estimate the maximum custom_id length for a user id without signing,
 * so callers can reject oversized ids before doing async work.
 */
export function estimateCustomIdLength(userId: string): number {
	const expirySeconds = Math.floor((Date.now() + EXPIRY_WINDOW_MS) / 1000);
	return (
		CUSTOM_ID_PREFIX.length +
		userId.length +
		SEPARATOR.length +
		String(expirySeconds).length +
		SEPARATOR.length +
		SIGNATURE_LENGTH
	);
}
