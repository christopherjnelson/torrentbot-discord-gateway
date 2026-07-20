import { fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	buildCustomId,
	createPayload,
	parseAndVerifyCustomId,
	isValidInfoHash,
	CUSTOM_ID_PREFIX,
} from "../src/utils/signing";
import { TEST_SIGNING_SECRET } from "./fixtures";
import {
	dispatchInteraction,
	interceptFollowupCreate,
	interceptFollowupEdit,
	makeCommandInteraction,
	makeComponentInteraction,
	TEST_APPLICATION_ID,
	TEST_GUILD_ID,
	TEST_INTERACTION_TOKEN,
	TEST_UNAUTHORIZED_GUILD_ID,
	TEST_USER_ID,
} from "./helpers";

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
	fetchMock.deactivate();
});

describe("component signing utility", () => {
	it("creates valid payloads and verifies them", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		expect(customId).toContain(CUSTOM_ID_PREFIX);

		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).not.toBeNull();
		expect(parsed?.userId).toBe("user-1");
		// The info hash is carried separately in the option value, not the
		// signed custom_id, so it is not round-tripped here.
		expect(parsed?.infoHash).toBe("");
	});

	it("rejects tampered payloads", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		// Tamper with the payload
		const tampered = customId.slice(0, -10) + "tampered00";
		const parsed = await parseAndVerifyCustomId(tampered, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("rejects wrong secret", async () => {
		const payload = createPayload("user-1", "a".repeat(40));
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const parsed = await parseAndVerifyCustomId(customId, "wrong-secret");
		expect(parsed).toBeNull();
	});

	it("rejects expired payloads", async () => {
		const payload = {
			userId: "user-1",
			infoHash: "a".repeat(40),
			expiry: Date.now() - 1000, // expired
		};
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const parsed = await parseAndVerifyCustomId(customId, TEST_SIGNING_SECRET);
		expect(parsed).toBeNull();
	});

	it("validates info hashes correctly", () => {
		expect(isValidInfoHash("a".repeat(40))).toBe(true);
		expect(isValidInfoHash("A".repeat(40))).toBe(true);
		expect(isValidInfoHash("g".repeat(40))).toBe(false); // 'g' is not hex
		expect(isValidInfoHash("a".repeat(39))).toBe(false); // too short
		expect(isValidInfoHash("a".repeat(41))).toBe(false); // too long
	});
});

describe("component interaction handling", () => {
	it("rejects interaction without custom_id", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: { values: ["hash"] } as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("Invalid component interaction");
	});

	it("rejects when signing secret is not configured", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: "torrentbot:add-result:invalid",
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: "" },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("not configured");
	});

	it("rejects tampered custom_id", async () => {
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: "torrentbot:add-result:invalid|tampered",
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("expired or is invalid");
	});

	it("rejects wrong user", async () => {
		const payload = createPayload("other-user", "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{ COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET },
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("someone else");
	});

	it("rejects interactions from an unauthorized guild", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
					guild_id: TEST_UNAUTHORIZED_GUILD_ID,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID,
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as {
			type: number;
			data: { flags?: number; content: string; components?: object[] };
		};
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toBe(
			"TorrentBot is not enabled for this server.",
		);
		// The original menu is not removed on authorization failure.
		expect(body.data.components).toBeUndefined();
	});

	it("rejects a valid signed component used in a DM", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
					member: undefined,
					user: { id: TEST_USER_ID },
					guild_id: undefined,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID,
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toBe(
			"TorrentBot can only be used in an authorized server.",
		);
	});

	it("rejects invalid info hash in selection", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["invalid-hash"],
					} as any,
				}),
			),
		{
			COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
			TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID,
		},
	);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		// Invalid hash is rejected immediately (before background processing)
		expect(body.data.content).toContain("Invalid selection");
	});

	it("rejects when TorBox is not configured", async () => {
		const payload = createPayload(TEST_USER_ID, "");
		const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
		const { response } = await dispatchInteraction(
			JSON.stringify(
				makeComponentInteraction({
					data: {
						custom_id: customId,
						values: ["a".repeat(40)],
					} as any,
				}),
			),
			{
				COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
				TORBOX_API_KEY: "",
				TORBOX_ALLOWED_GUILD_IDS: TEST_GUILD_ID,
			},
		);
		expect(response.status).toBe(200);
		const body = await response.json() as { data: { content: string } };
		expect(body.data.content).toContain("not configured");
	});
});

const TEST_HASH = "a".repeat(40);
const TEST_DOWNLOAD_URL =
	"https://tb-cdn.example/dld/11111111-2222-3333-4444-555555555555?token=x";

function tbCreateOk(id: number, hash: string): string {
	return JSON.stringify({
		success: true,
		error: null,
		detail: "Torrent Added Successfully",
		data: { hash, torrent_id: id, auth_id: "auth-x" },
	});
}

const TB_DUPLICATE = JSON.stringify({
	success: false,
	error: "DUPLICATE_ITEM",
	detail: "This item already exists.",
	data: null,
});

function tbTorrentRaw(overrides: Record<string, unknown> = {}) {
	return {
		id: 42,
		hash: TEST_HASH,
		name: "Backrooms (2026) [1080p]",
		size: 1468006400,
		active: false,
		created_at: "2026-07-20T00:00:00Z",
		updated_at: "2026-07-20T00:00:10Z",
		download_state: "cached",
		seeds: 0,
		peers: 0,
		progress: 1,
		download_speed: 0,
		upload_speed: 0,
		download_finished: true,
		download_present: true,
		cached: true,
		files: [
			{ id: 0, name: "Backrooms.2026.1080p.WEB-DL.x264-GRP.mkv", size: 1468006400 },
		],
		...overrides,
	};
}

function tbListBody(data: unknown): string {
	return JSON.stringify({
		success: true,
		error: null,
		detail: "Torrent list retrieved successfully.",
		data,
	});
}

function tbLinkBody(url: string): string {
	return JSON.stringify({
		success: true,
		error: null,
		detail: "Torrent download requested successfully.",
		data: url,
	});
}

function interceptTbCreate(status: number, body: string): void {
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: "/v1/api/torrents/createtorrent", method: "POST" })
		.reply(status, body);
}

/** Intercept `count` sequential mylist calls with the same body. */
function interceptTbMylist(body: string, count = 1): void {
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
		.reply(200, body)
		.times(count);
}

/** Intercept mylist calls, routing on the id query parameter. */
function interceptTbMylistRouted(
	byId: string,
	fullList: string,
): void {
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
		.reply((opts) => {
			const hasId = new URL(`https://api.torbox.app${opts.path}`).searchParams.has("id");
			return { statusCode: 200, data: hasId ? byId : fullList };
		})
		.times(2);
}

function interceptTbRequestdl(
	body: string,
	status = 200,
): { query: () => URLSearchParams } {
	let params: URLSearchParams | undefined;
	fetchMock
		.get("https://api.torbox.app")
		.intercept({ path: /^\/v1\/api\/torrents\/requestdl/ })
		.reply((opts) => {
			params = new URL(`https://api.torbox.app${opts.path}`).searchParams;
			return { statusCode: status, data: body };
		});
	return { query: () => params as URLSearchParams };
}

async function dispatchSelection(
	extraEnv: Record<string, string> = {},
): Promise<ReturnType<typeof dispatchInteraction>> {
	const payload = createPayload(TEST_USER_ID, "");
	const customId = await buildCustomId(payload, TEST_SIGNING_SECRET);
	return dispatchInteraction(
		JSON.stringify(
			makeComponentInteraction({
				data: { custom_id: customId, values: [TEST_HASH] } as any,
			}),
		),
		{
			COMPONENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
			TORBOX_POLL_INTERVAL_MS: "250",
			...extraEnv,
		},
	);
}

describe("component TorBox download flow", () => {
	it("removes the menu and returns an ephemeral link for a ready torrent", async () => {
		const followups = interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(200, tbCreateOk(42, TEST_HASH));
		interceptTbMylist(tbListBody(tbTorrentRaw()));
		const dl = interceptTbRequestdl(tbLinkBody(TEST_DOWNLOAD_URL));

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		const initial = await response.json() as {
			type: number;
			data: { components?: object[]; content?: string };
		};
		// The select menu is removed via UPDATE_MESSAGE; no content is shown.
		expect(initial.type).toBe(7);
		expect(initial.data.components).toEqual([]);
		expect(initial.data.content).toBeUndefined();

		await waitOnExecutionContext(ctx);

		// The progress message and result are ephemeral followups.
		expect(followups.captured).toHaveLength(1);
		expect(followups.captured[0].body.flags).toBe(64);
		expect(followups.captured[0].body.content).toContain("Adding to TorBox");

		expect(edits.captured).toHaveLength(1);
		const final = edits.captured[0].body.content as string;
		expect(final).toContain("Added to TorBox.");
		expect(final).toContain("**Backrooms (2026) [1080p]**");
		expect(final).toContain("Ready to download:");
		expect(final).toContain(`[Download file](${TEST_DOWNLOAD_URL})`);
		expect(final).toContain("Backrooms.2026.1080p.WEB-DL.x264-GRP.mkv");
		expect(final).toContain("1.4 GiB");
		expect(final).not.toContain(TEST_INTERACTION_TOKEN);

		// The link request used the documented parameters.
		expect(dl.query().get("torrent_id")).toBe("42");
		expect(dl.query().get("file_id")).toBe("0");
		expect(dl.query().get("zip_link")).toBeNull();
	});

	it("returns a zip archive link for a multi-file torrent", async () => {
		const followups = interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(200, tbCreateOk(42, TEST_HASH));
		interceptTbMylist(
			tbListBody(
				tbTorrentRaw({
					files: [
						{ id: 0, name: "Backrooms.2026.1080p.mkv", size: 1468006400 },
						{ id: 1, name: "sample.mkv", size: 52428800 },
						{ id: 2, name: "subs.srt", size: 51200 },
					],
				}),
			),
		);
		const dl = interceptTbRequestdl(tbLinkBody(TEST_DOWNLOAD_URL));

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("Ready to download (3 files):");
		expect(final).toContain(`[Download archive (zip)](${TEST_DOWNLOAD_URL})`);
		expect(dl.query().get("zip_link")).toBe("true");
		expect(dl.query().get("file_id")).toBeNull();
		expect(followups.captured[0].body.flags).toBe(64);
	});

	it("reports still processing when the poll budget is exhausted", async () => {
		const followups = interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(200, tbCreateOk(42, TEST_HASH));
		interceptTbMylist(
			tbListBody(
				tbTorrentRaw({
					download_finished: false,
					download_state: "downloading",
					progress: 0.4,
				}),
			),
			2,
		);

		const { response, ctx } = await dispatchSelection({
			TORBOX_POLL_MAX_ATTEMPTS: "2",
		});
		expect(response.status).toBe(200);
		const initial = await response.json() as { type: number };
		expect(initial.type).toBe(7);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("Added to TorBox.");
		expect(final).toContain("**Backrooms (2026) [1080p]**");
		expect(final).toContain("still processing");
		expect(final).toContain("ID `42`");
		expect(final).toContain("/status");
		expect(final).not.toContain("http");
		expect(followups.captured[0].body.flags).toBe(64);
	});

	it("recovers a duplicate submission by hash and still links it", async () => {
		const followups = interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(400, TB_DUPLICATE);
		interceptTbMylistRouted(
			tbListBody(tbTorrentRaw({ id: 77 })),
			tbListBody([tbTorrentRaw({ id: 77, hash: TEST_HASH.toUpperCase() })]),
		);
		const dl = interceptTbRequestdl(tbLinkBody(TEST_DOWNLOAD_URL));

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("Already on TorBox.");
		expect(final).toContain(`[Download file](${TEST_DOWNLOAD_URL})`);
		expect(dl.query().get("torrent_id")).toBe("77");
		expect(followups.captured[0].body.flags).toBe(64);
	});

	it("handles a duplicate that cannot be located", async () => {
		interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(400, TB_DUPLICATE);
		interceptTbMylist(tbListBody([]));

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("already on your TorBox account");
		expect(final).toContain("couldn't locate it");
		expect(final).toContain("/status");
		expect(final).not.toContain("http");
	});

	it("reports link-generation failure without leaking the URL", async () => {
		interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(200, tbCreateOk(42, TEST_HASH));
		interceptTbMylist(tbListBody(tbTorrentRaw()));
		interceptTbRequestdl(
			JSON.stringify({
				success: false,
				error: "DATABASE_ERROR",
				detail: "Failed to request torrent download. Please try again later.",
				data: null,
			}),
			500,
		);

		const warnings: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			const { response, ctx } = await dispatchSelection();
			expect(response.status).toBe(200);
			await waitOnExecutionContext(ctx);
		} finally {
			console.warn = originalWarn;
		}

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("could not generate a download link yet");
		expect(final).toContain("/status");
		expect(final).not.toContain("http");
		for (const args of warnings) {
			expect(args.join(" ")).not.toContain(TEST_DOWNLOAD_URL);
			expect(args.join(" ")).not.toContain("token=");
		}
	});

	it("reports poll failures and still settles the interaction", async () => {
		interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(200, tbCreateOk(42, TEST_HASH));
		fetchMock
			.get("https://api.torbox.app")
			.intercept({ path: /^\/v1\/api\/torrents\/mylist/ })
			.reply(500, "boom");

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final).toContain("Added to TorBox.");
		expect(final).toContain("couldn't check whether it's ready");
		expect(final).toContain("/status");
	});

	it("reports TorBox add failures", async () => {
		interceptFollowupCreate();
		const edits = interceptFollowupEdit();
		interceptTbCreate(
			403,
			JSON.stringify({
				success: false,
				error: "BAD_TOKEN",
				detail: "Invalid API token.",
				data: null,
			}),
		);

		const { response, ctx } = await dispatchSelection();
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const final = edits.captured[0].body.content as string;
		expect(final.length).toBeGreaterThan(0);
		expect(final).not.toContain("magnet:");
		expect(final).not.toContain("http");
	});
});