import {
env,
createExecutionContext,
waitOnExecutionContext,
SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("TorrentBot Discord gateway", () => {
it("returns the health response for GET /", async () => {
const request = new IncomingRequest("https://example.com/");
const ctx = createExecutionContext();

		const response = await worker.fetch!(request, env, ctx);

await waitOnExecutionContext(ctx);

expect(response.status).toBe(200);
expect(await response.json()).toEqual({
ok: true,
service: "torrentbot-discord-gateway",
status: "healthy",
});
});

it("rejects an unsigned Discord interaction", async () => {
const response = await SELF.fetch(
"https://example.com/discord/interactions",
{
method: "POST",
headers: {
"Content-Type": "application/json",
},
body: '{"type":1}',
},
);

expect(response.status).toBe(401);
expect(await response.json()).toEqual({
ok: false,
error: "Missing Discord signature headers",
});
});

it("rejects invalid Discord signature headers", async () => {
const response = await SELF.fetch(
"https://example.com/discord/interactions",
{
method: "POST",
headers: {
"Content-Type": "application/json",
"X-Signature-Ed25519": "invalid",
"X-Signature-Timestamp": "1234567890",
},
body: '{"type":1}',
},
);

expect(response.status).toBe(401);
expect(await response.json()).toEqual({
ok: false,
error: "Invalid request signature",
});
});

it("returns 404 for unknown paths", async () => {
const response = await SELF.fetch("https://example.com/nope");

expect(response.status).toBe(404);
expect(await response.json()).toEqual({
ok: false,
error: "Not found",
});
});

it("returns 404 for unsupported routes and methods", async () => {
const response = await SELF.fetch("https://example.com/", {
method: "DELETE",
});

expect(response.status).toBe(404);
expect(await response.json()).toEqual({
ok: false,
error: "Not found",
});
});
});
