/**
 * Magnet URI validation.
 *
 * Accepts the overwhelmingly common BitTorrent v1 form:
 *   magnet:?xt=urn:btih:<40 hex chars | 32 base32 chars>[&...]
 * Additional xt=urn:btmh (v2) exact topics are also accepted.
 * Validation is intentionally strict: this value is submitted to TorBox.
 */
const MAGNET_PATTERN =
	/^magnet:\?xt=urn:(btih:[a-zA-Z0-9]{32}|btih:[a-fA-F0-9]{40}|btmh:[a-fA-F0-9]{32,128})(\s|&.*)?$/;

export function isValidMagnetUri(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length > 4096) {
		return false;
	}
	return MAGNET_PATTERN.test(trimmed);
}
