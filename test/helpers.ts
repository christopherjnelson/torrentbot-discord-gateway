import nodeCrypto from "node:crypto";
import { env } from "cloudflare:test";
import type { CommandOption, DiscordInteraction } from "../src/discord/types";

/**
 * Test-only Ed25519 key pair standing in for the Discord application key.
 * Production verification is unchanged: tests sign requests the same way
 * Discord would and point the Worker at this public key via env overrides.
 */
const keyPair = nodeCrypto.generateKeyPairSync("ed25519");

export const TEST_PUBLIC_KEY_HEX = keyPair.publicKey
	.export({ format: "der", type: "spki" })
	.subarray(-32)
	.toString("hex");

export const TEST_APPLICATION_ID = "app-123";
export const TEST_INTERACTION_TOKEN = "test-interaction-token";
export const TEST_USER_ID = "user-1";
export const TEST_GUILD_ID = "guild-1";

/** Deterministic Worker env for tests; never depends on real .dev.vars. */
export function testEnv(overrides: Record<string, string> = {}): Env {
	return {
		...env,
		DISCORD_PUBLIC_KEY: TEST_PUBLIC_KEY_HEX,
		VOYAGER_API_KEY: "test-voyager-key",
		TORBOX_API_KEY: "test-torbox-key",
		INTERNAL_API_TOKEN: "test-internal-token",
		TORBOX_ALLOWED_USER_IDS: TEST_USER_ID,
		UPSTREAM_TIMEOUT_MS: "10000",
		...overrides,
	} as unknown as Env;
}

/** Sign a raw request body the way Discord signs interaction payloads. */
export function signBody(body: string, timestamp: string): string {
	return nodeCrypto
		.sign(null, Buffer.from(timestamp + body), keyPair.privateKey)
		.toString("hex");
}

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** Build a signed POST /discord/interactions request for an arbitrary body. */
export function signedInteractionRequest(body: string) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	return new IncomingRequest("https://example.com/discord/interactions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-signature-ed25519": signBody(body, timestamp),
			"x-signature-timestamp": timestamp,
		},
		body,
	});
}

export function makeInteraction(
	overrides: Partial<DiscordInteraction> = {},
): DiscordInteraction {
	return {
		id: "interaction-1",
		application_id: TEST_APPLICATION_ID,
		type: 2,
		token: TEST_INTERACTION_TOKEN,
		guild_id: TEST_GUILD_ID,
		member: { user: { id: TEST_USER_ID } },
		...overrides,
	};
}

export function makeCommandInteraction(
	commandName: string,
	options?: CommandOption[],
	overrides: Partial<DiscordInteraction> = {},
): DiscordInteraction {
	return makeInteraction({
		data: { name: commandName, options },
		...overrides,
	});
}
