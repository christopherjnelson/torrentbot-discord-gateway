/**
 * Runtime configuration derived from Worker environment bindings.
 *
 * Secrets are typed by `wrangler types` as required strings, but at runtime
 * any of them may be missing (e.g. a secret was never `put`). All accessors
 * therefore normalize to `undefined` for absent/empty values, and feature
 * handlers degrade gracefully instead of crashing.
 */

export interface AppConfig {
	/** Discord application public key (Ed25519) for request verification. */
	discordPublicKey: string | undefined;
	/**
	 * API key for the Voyager Torznab search endpoint. Falls back to
	 * TORBOX_API_KEY: per TorBox docs the Voyager `apikey` is the account's
	 * TorBox API key (documented assumption in README).
	 */
	voyagerApiKey: string | undefined;
	/** TorBox API key for /add and /status and /api/torrents. */
	torboxApiKey: string | undefined;
	/** Bearer token required on all /api/* routes. */
	internalApiToken: string | undefined;
	/** Discord user IDs allowed to run /add and /status. */
	torboxAllowedUserIds: string[];
	/** Timeout applied to Voyager/TorBox upstream calls. */
	upstreamTimeoutMs: number;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readTimeoutMs(value: unknown): number {
	const parsed = Number.parseInt(readString(value) ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60_000) {
		return DEFAULT_UPSTREAM_TIMEOUT_MS;
	}
	return parsed;
}

export function getConfig(env: Env): AppConfig {
	const torboxApiKey = readString(env.TORBOX_API_KEY);
	return {
		discordPublicKey: readString(env.DISCORD_PUBLIC_KEY),
		voyagerApiKey: readString(env.VOYAGER_API_KEY) ?? torboxApiKey,
		torboxApiKey,
		internalApiToken: readString(env.INTERNAL_API_TOKEN),
		torboxAllowedUserIds: (readString(env.TORBOX_ALLOWED_USER_IDS) ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
		upstreamTimeoutMs: readTimeoutMs(env.UPSTREAM_TIMEOUT_MS),
	};
}

/** Check whether a Discord user ID is on the TorBox allowlist. */
export function isAllowedTorboxUser(
	config: AppConfig,
	userId: string | undefined,
): boolean {
	if (!userId) {
		return false;
	}
	return config.torboxAllowedUserIds.includes(userId);
}
