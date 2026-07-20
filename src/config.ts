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
	/** Base URL of the Prowlarr instance backing /search and /api/search. */
	prowlarrUrl: string | undefined;
	/** Prowlarr API key (sent as the X-Api-Key header). */
	prowlarrApiKey: string | undefined;
	/** TorBox API key for /add and /status and /api/torrents. */
	torboxApiKey: string | undefined;
	/** Bearer token required on all /api/* routes. */
	internalApiToken: string | undefined;
	/** Discord user IDs allowed to run /add and /status. */
	torboxAllowedUserIds: string[];
	/** Timeout applied to Prowlarr/TorBox upstream calls. */
	upstreamTimeoutMs: number;
	/** Secret used to sign and verify Discord component payloads. */
	componentSigningSecret: string | undefined;
	/** Delay between TorBox readiness polls after adding a torrent. */
	torboxPollIntervalMs: number;
	/** Maximum number of TorBox readiness polls after adding a torrent. */
	torboxPollMaxAttempts: number;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_TORBOX_POLL_INTERVAL_MS = 2_500;
const DEFAULT_TORBOX_POLL_MAX_ATTEMPTS = 7;

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

/**
 * Read an optional positive-integer env var within [min, max], falling back
 * to `fallback` when missing or invalid.
 */
function readBoundedInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed = Number.parseInt(readString(value) ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return parsed;
}

export function getConfig(env: Env): AppConfig {
	return {
		discordPublicKey: readString(env.DISCORD_PUBLIC_KEY),
		prowlarrUrl: readString(env.PROWLARR_URL),
		prowlarrApiKey: readString(env.PROWLARR_API_KEY),
		torboxApiKey: readString(env.TORBOX_API_KEY),
		internalApiToken: readString(env.INTERNAL_API_TOKEN),
		torboxAllowedUserIds: (readString(env.TORBOX_ALLOWED_USER_IDS) ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
		upstreamTimeoutMs: readTimeoutMs(env.UPSTREAM_TIMEOUT_MS),
		componentSigningSecret: readString(env.COMPONENT_SIGNING_SECRET),
		torboxPollIntervalMs: readBoundedInt(
			env.TORBOX_POLL_INTERVAL_MS,
			250,
			10_000,
			DEFAULT_TORBOX_POLL_INTERVAL_MS,
		),
		torboxPollMaxAttempts: readBoundedInt(
			env.TORBOX_POLL_MAX_ATTEMPTS,
			1,
			20,
			DEFAULT_TORBOX_POLL_MAX_ATTEMPTS,
		),
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
