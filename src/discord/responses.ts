/**
 * Builders for Discord interaction callback responses.
 *
 * Callback types verified against the official docs:
 * - PONG = 1
 * - CHANNEL_MESSAGE_WITH_SOURCE = 4
 * - DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5 (ACK now, edit later via
 *   PATCH /webhooks/{application.id}/{interaction.token}/messages/@original)
 * - UPDATE_MESSAGE = 7 (component interactions only: edit the message the
 *   component was attached to; the user sees no loading state)
 *
 * Every message we send sets `allowed_mentions: { parse: [] }` so message
 * content can never trigger user/role/@everyone/@here pings.
 */

export const CALLBACK_PONG = 1;
export const CALLBACK_CHANNEL_MESSAGE = 4;
export const CALLBACK_DEFERRED_MESSAGE = 5;
export const CALLBACK_UPDATE_MESSAGE = 7;

/** Message flag EPHEMERAL (1 << 6): only the invoker sees the message. */
export const FLAG_EPHEMERAL = 64;

const NO_MENTIONS = { parse: [] as string[] };

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** ACK a Discord PING. */
export function pongResponse(): Response {
	return json({ type: CALLBACK_PONG });
}

/**
 * ACK an application command and respond later by editing the original
 * response. The initial callback must happen within Discord's 3-second
 * deadline; heavy upstream work runs afterwards via ctx.waitUntil.
 */
export function deferredMessageResponse(ephemeral = false): Response {
	if (ephemeral) {
		return json({
			type: CALLBACK_DEFERRED_MESSAGE,
			data: { flags: FLAG_EPHEMERAL },
		});
	}
	return json({ type: CALLBACK_DEFERRED_MESSAGE });
}

/** Respond to an interaction immediately with a message. */
export function messageResponse(content: string, ephemeral = false): Response {
	return json({
		type: CALLBACK_CHANNEL_MESSAGE,
		data: {
			content,
			allowed_mentions: NO_MENTIONS,
			...(ephemeral ? { flags: FLAG_EPHEMERAL } : {}),
		},
	});
}

/**
 * ACK a message-component interaction by editing the message the component
 * was attached to (e.g. removing the search select menu after a selection).
 * The user sees no loading state. Only valid for component interactions.
 */
export function updateMessageResponse(data: { components?: object[] }): Response {
	return json({
		type: CALLBACK_UPDATE_MESSAGE,
		data: { ...data, allowed_mentions: NO_MENTIONS },
	});
}

/** Standard JSON error envelope used by all non-Discord-callback routes. */
export function errorResponse(error: string, status: number): Response {
	return json({ ok: false, error }, status);
}
