import { errorResponse } from "./discord/responses";
import { handleDiscordInteractions } from "./routes/discord";

/**
 * TorrentBot Discord gateway.
 *
 * Routes:
 * - GET  /                      health check
 * - POST /discord/interactions  Discord interaction webhook (Ed25519 verified)
 * - /api/*                      internal authenticated HTTP API (see routes/api)
 */
const handler: ExportedHandler<Env> = {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return Response.json({
				ok: true,
				service: "torrentbot-discord-gateway",
				status: "healthy",
			});
		}

		if (
			request.method === "POST" &&
			url.pathname === "/discord/interactions"
		) {
			return handleDiscordInteractions(request, env, ctx);
		}

		return errorResponse("Not found", 404);
	},
};

export default handler;
