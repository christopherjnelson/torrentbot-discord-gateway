/**
 * Normalized error types for upstream service failures.
 *
 * Messages in these errors must never contain secrets, tokens, magnet URIs,
 * or full request URLs. They are safe to log and (for UserInputError /
 * sanitized variants) safe to surface to Discord users.
 */

/** Which upstream service failed. */
export type UpstreamService = "voyager" | "torbox" | "discord";

/** The upstream service did not respond within the configured timeout. */
export class UpstreamTimeoutError extends Error {
	readonly service: UpstreamService;

	constructor(service: UpstreamService, timeoutMs: number) {
		super(`${service} request timed out after ${timeoutMs}ms`);
		this.name = "UpstreamTimeoutError";
		this.service = service;
	}
}

/** The upstream service returned a non-2xx HTTP status. */
export class UpstreamStatusError extends Error {
	readonly service: UpstreamService;
	readonly status: number;

	constructor(service: UpstreamService, status: number) {
		super(`${service} returned HTTP ${status}`);
		this.name = "UpstreamStatusError";
		this.service = service;
		this.status = status;
	}
}

/** A network-level failure prevented the request from completing. */
export class UpstreamNetworkError extends Error {
	readonly service: UpstreamService;

	constructor(service: UpstreamService) {
		super(`${service} request failed due to a network error`);
		this.name = "UpstreamNetworkError";
		this.service = service;
	}
}

/** The upstream response body could not be parsed or had an unexpected shape. */
export class UpstreamParseError extends Error {
	readonly service: UpstreamService;

	constructor(service: UpstreamService, detail = "unparseable response") {
		super(`${service} ${detail}`);
		this.name = "UpstreamParseError";
		this.service = service;
	}
}

/** The Torznab endpoint returned a protocol-level <error> document. */
export class TorznabResponseError extends Error {
	readonly code: string | null;

	constructor(description: string, code: string | null) {
		super(description);
		this.name = "TorznabResponseError";
		this.code = code;
	}
}

/** A required configuration value (secret/var) is missing at runtime. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Input supplied by a user failed validation. Message is safe to show. */
export class UserInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserInputError";
	}
}
