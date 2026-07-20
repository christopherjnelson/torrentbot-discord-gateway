/**
 * Stateless component payload signing using HMAC-SHA-256.
 *
 * Discord component values and custom_ids have length limits, so the signed
 * payload is kept compact:
 *   <user_id>|<info_hash>|<expiry_timestamp>
 *
 * The signature is computed over this payload and appended after a separator.
 * The full custom_id or value is:
 *   torrentbot:add-result:<payload>|<signature_hex>
 *
 * Security properties:
 * - HMAC-SHA-256 via Web Crypto (available in Cloudflare Workers).
 * - Constant-time signature comparison.
 * - Optional expiry (10-15 minute window recommended).
 * - Payload does not contain API keys, tokens, or full magnet URIs.
 */

export const CUSTOM_ID_PREFIX = "torrentbot:add-result:";
export const SEPARATOR = "|";
export const EXPIRY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface ComponentPayload {
	userId: string;
	infoHash: string;
	expiry: number;
}

/**
 * Build the plaintext payload string from a ComponentPayload.
 * Format: <userId>|<infoHash>|<expiry>
 */
export function encodePayload(payload: ComponentPayload): string {
	return `${payload.userId}${SEPARATOR}${payload.infoHash}${SEPARATOR}${payload.expiry}`;
}

/**
 * Parse a plaintext payload string. Returns null if malformed.
 */
export function decodePayload(raw: string): ComponentPayload | null {
	const parts = raw.split(SEPARATOR);
	if (parts.length !== 3) {
		return null;
	}
	const [userId, infoHash, expiryStr] = parts;
	const expiry = Number(expiryStr);
	if (
		!userId ||
		!Number.isFinite(expiry) ||
		expiry <= 0
	) {
		return null;
	}
	return { userId, infoHash: infoHash ?? "", expiry };
}

/**
 * Sign a payload using HMAC-SHA-256.
 * Returns the hex-encoded signature.
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
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Verify a payload + hex signature using constant-time comparison.
 */
export async function verifySignature(
	payload: string,
	hexSignature: string,
	secret: string,
): Promise<boolean> {
	const expectedSig = await signPayload(payload, secret);
	if (hexSignature.length !== expectedSig.length) {
		return false;
	}
	const encoder = new TextEncoder();
	const expectedBytes = encoder.encode(expectedSig);
	const actualBytes = encoder.encode(hexSignature);
	let diff = 0;
	for (let i = 0; i < expectedBytes.length; i++) {
		diff |= expectedBytes[i] ^ actualBytes[i];
	}
	return diff === 0;
}

/**
 * Build a full custom_id for a select menu option.
 * Format: torrentbot:add-result:<payload>|<signature>
 */
export async function buildCustomId(
	payload: ComponentPayload,
	secret: string,
): Promise<string> {
	const encoded = encodePayload(payload);
	const signature = await signPayload(encoded, secret);
	return `${CUSTOM_ID_PREFIX}${encoded}${SEPARATOR}${signature}`;
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
	const hexSignature = signedPart.slice(lastSep + 1);
	if (!payload || !hexSignature) {
		return null;
	}
	const valid = await verifySignature(payload, hexSignature, secret);
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
