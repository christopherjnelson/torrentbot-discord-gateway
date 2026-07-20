import { verifyKey } from "discord-interactions";

/**
 * Discord Ed25519 request verification.
 *
 * Discord signs `timestamp + rawBody` with the application's key pair; the
 * public key comes from the Developer Portal. Verification uses the official
 * discord-interactions helper (Web Crypto Ed25519).
 */

export type VerificationResult =
	| { valid: true; rawBody: string }
	| { valid: false; reason: "missing-headers" | "bad-signature" };

export async function verifyDiscordRequest(
	request: Request,
	publicKey: string,
): Promise<VerificationResult> {
	const signature = request.headers.get("x-signature-ed25519");
	const timestamp = request.headers.get("x-signature-timestamp");

	if (!signature || !timestamp) {
		return { valid: false, reason: "missing-headers" };
	}

	const rawBody = await request.text();
	const isValid = await verifyKey(rawBody, signature, timestamp, publicKey);

	if (!isValid) {
		return { valid: false, reason: "bad-signature" };
	}
	return { valid: true, rawBody };
}
