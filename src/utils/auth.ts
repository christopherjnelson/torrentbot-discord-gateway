/**
 * Constant-time bearer-token check for the internal API.
 */

async function sha256(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return new Uint8Array(digest);
}

/**
 * Compare two secrets without early-exit timing leaks. Both values are hashed
 * first so the comparison always runs over fixed 32-byte values regardless of
 * input length (which also avoids leaking the expected length).
 */
export async function safeSecretEqual(
	provided: string,
	expected: string,
): Promise<boolean> {
	const [providedHash, expectedHash] = await Promise.all([
		sha256(provided),
		sha256(expected),
	]);
	let diff = 0;
	for (let i = 0; i < providedHash.length; i++) {
		diff |= providedHash[i] ^ expectedHash[i];
	}
	return diff === 0;
}

/**
 * Validate an `Authorization: Bearer <token>` header against the expected
 * token using a constant-time comparison.
 */
export async function isValidBearer(
	authorizationHeader: string | null,
	expectedToken: string,
): Promise<boolean> {
	if (!authorizationHeader) {
		return false;
	}
	const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
	if (!match) {
		return false;
	}
	return safeSecretEqual(match[1], expectedToken);
}
