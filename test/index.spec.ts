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

const response = await worker.fetch(request, env, ctx);

await waitOnExecutionContext(ctx);

expect(response.status).toBe(200);
expect(response.headers.get("content-type")).toContain(
"application/json",
);
expect(await response.json()).toEqual({
ok: true,
service: "torrentbot-discord-gateway",
status: "healthy",
});
});

it("reads the exact raw body for POST /", async () => {
const rawBody = '{"type":1,"message":"test"}';
const response = await SELF.fetch("https://example.com/", {
method: "POST",
headers: {
"Content-Type": "application/json",
},
body: rawBody,
});

expect(response.status).toBe(200);
expect(await response.json()).toEqual({
ok: true,
received: true,
contentType: "application/json",
bodyLength: rawBody.length,
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

it("returns 405 for unsupported methods", async () => {
const response = await SELF.fetch("https://example.com/", {
method: "DELETE",
});

expect(response.status).toBe(405);
expect(response.headers.get("allow")).toBe("GET, POST");
expect(await response.json()).toEqual({
ok: false,
error: "Method not allowed",
});
});
});
