import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				// Keep tests isolated from the repository's local .dev.vars.
				// Every external credential used by tests is a deterministic
				// mock supplied by test/helpers.ts.
				main: "./src/index.ts",
				miniflare: {
					compatibilityDate: "2026-07-24",
					compatibilityFlags: ["nodejs_compat"],
					bindings: {
						DISCORD_PUBLIC_KEY:
							"0000000000000000000000000000000000000000000000000000000000000000",
						UPSTREAM_TIMEOUT_MS: "10000",
						TORBOX_POLL_INTERVAL_MS: "2500",
						TORBOX_POLL_MAX_ATTEMPTS: "7",
					},
				},
			},
		},
	},
});
