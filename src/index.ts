import {
InteractionResponseType,
InteractionType,
verifyKey,
} from "discord-interactions";

function jsonResponse(body: unknown, status = 200): Response {
return Response.json(body, { status });
}

export default {
async fetch(request, env): Promise<Response> {
const url = new URL(request.url);

if (request.method === "GET" && url.pathname === "/") {
return jsonResponse({
ok: true,
service: "torrentbot-discord-gateway",
status: "healthy",
});
}

if (
request.method === "POST" &&
url.pathname === "/discord/interactions"
) {
const signature = request.headers.get("x-signature-ed25519");
const timestamp = request.headers.get("x-signature-timestamp");

if (!signature || !timestamp) {
return jsonResponse(
{
ok: false,
error: "Missing Discord signature headers",
},
401,
);
}

const rawBody = await request.text();

const isValidRequest = await verifyKey(
rawBody,
signature,
timestamp,
env.DISCORD_PUBLIC_KEY,
);

if (!isValidRequest) {
return jsonResponse(
{
ok: false,
error: "Invalid request signature",
},
401,
);
}

let interaction: { type?: number };

try {
interaction = JSON.parse(rawBody) as { type?: number };
} catch {
return jsonResponse(
{
ok: false,
error: "Invalid JSON body",
},
400,
);
}

if (interaction.type === InteractionType.PING) {
return jsonResponse({
type: InteractionResponseType.PONG,
});
}

return jsonResponse(
{
ok: false,
error: "Unsupported interaction type",
},
400,
);
}

return jsonResponse(
{
ok: false,
error: "Not found",
},
404,
);
},
} satisfies ExportedHandler<Env>;
