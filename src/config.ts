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
	/** TMDB API read access token for movie/TV disambiguation. */
	tmdbReadAccessToken: string | undefined;
	/** TorBox API key for /add and /status and /api/torrents. */
	torboxApiKey: string | undefined;
	/** Bearer token required on all /api/* routes. */
	internalApiToken: string | undefined;
	/**
	 * Discord guild (server) IDs whose members may run TorBox-facing
	 * commands (/add, /status, and the search-result selection flow).
	 * Empty when the configuration is missing, empty, or malformed, in
	 * which case Discord TorBox access is denied.
	 */
	torboxAllowedGuildIds: ReadonlySet<string>;
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

/**
 * Discord snowflakes are 64-bit unsigned integers serialized as decimal
 * strings (up to 20 digits). This is a structural check, not a guarantee
 * that the ID refers to a real guild.
 */
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

/**
 * Parse `TORBOX_ALLOWED_GUILD_IDS` into a de-duplicated set of guild IDs.
 *
 * Whitespace is trimmed, empty entries (e.g. from repeated commas) are
 * ignored, and every non-empty entry must be a snowflake-style decimal
 * string. If any entry is malformed the entire configuration is rejected
 * and an empty set is returned so that Discord TorBox access fails closed
 * rather than partially opening.
 */
function parseAllowedGuildIds(value: unknown): Set<string> {
	const raw = readString(value);
	if (!raw) {
		return new Set();
	}
	const entries: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) {
			continue;
		}
		if (!SNOWFLAKE_PATTERN.test(trimmed)) {
			return new Set();
		}
		entries.push(trimmed);
	}
	return new Set(entries);
}

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
		tmdbReadAccessToken: readString(env.TMDB_READ_ACCESS_TOKEN),
		torboxApiKey: readString(env.TORBOX_API_KEY),
		internalApiToken: readString(env.INTERNAL_API_TOKEN),
		torboxAllowedGuildIds: parseAllowedGuildIds(env.TORBOX_ALLOWED_GUILD_IDS),
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

/**
 * Outcome of authorizing a Discord interaction by its guild.
 *
 * - `allowed`: the interaction is from an authorized guild.
 * - `direct-message`: the interaction has no `guild_id` (a DM) — denied.
 * - `unauthorized-guild`: the guild is not in the configured allowlist.
 * - `configuration-unavailable`: the allowlist is missing, empty, or
 *   malformed; Discord TorBox access fails closed.
 */
export type GuildAuthStatus =
	| "allowed"
	| "direct-message"
	| "unauthorized-guild"
	| "configuration-unavailable";

/**
 * Authorize a Discord interaction by its guild ID against the configured
 * allowlist. Distinguishes enough cases for a clear user-facing response.
 */
export function authorizeGuild(
	guildId: string | undefined,
	allowedGuildIds: ReadonlySet<string>,
): GuildAuthStatus {
	if (allowedGuildIds.size === 0) {
		return "configuration-unavailable";
	}
	if (!guildId) {
		return "direct-message";
	}
	if (!allowedGuildIds.has(guildId)) {
		return "unauthorized-guild";
	}
	return "allowed";
}

/** Convenience boolean form of {@link authorizeGuild}. */
export function isGuildAuthorized(
	guildId: string | undefined,
	allowedGuildIds: ReadonlySet<string>,
): boolean {
	return authorizeGuild(guildId, allowedGuildIds) === "allowed";
}

/**
 * Map a non-allowed {@link GuildAuthStatus} to a concise ephemeral user
 * message. Returns the empty string for `allowed`. Never exposes
 * environment-variable names, internal identifiers, or config contents.
 */
export function guildAuthMessage(status: GuildAuthStatus): string {
	switch (status) {
		case "direct-message":
			return "TorrentBot can only be used in an authorized server.";
		case "unauthorized-guild":
			return "TorrentBot is not enabled for this server.";
		case "configuration-unavailable":
			return "TorrentBot authorization is not configured correctly.";
		default:
			return "";
	}
}
