export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== "/") {
			return Response.json(
				{
					ok: false,
					error: "Not found",
				},
				{ status: 404 },
			);
		}

		if (request.method === "GET") {
			return Response.json({
				ok: true,
				service: "torrentbot-discord-gateway",
				status: "healthy",
			});
		}

		if (request.method === "POST") {
			// Discord signature verification will eventually require the exact
			// unmodified request body, so deliberately read it as text first.
			const rawBody = await request.text();

			return Response.json({
				ok: true,
				received: true,
				contentType: request.headers.get("content-type"),
				bodyLength: rawBody.length,
			});
		}

		return Response.json(
			{
				ok: false,
				error: "Method not allowed",
			},
			{
				status: 405,
				headers: {
					Allow: "GET, POST",
				},
			},
		);
	},
} satisfies ExportedHandler<Env>;