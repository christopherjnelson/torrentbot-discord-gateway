---
type: Operations Playbook
title: Local development, command registration, and deployment
description: Safe local Worker development, deterministic test setup, Discord guild command registration, generated types, and deployment automation.
tags: [operations, development, deployment, testing, discord]
openwiki:
  roles: [operations, testing, delivery]
  change_kinds: [deployment, command-registration, generated-types]
  source_paths: [package.json, wrangler.jsonc, vitest.config.mts, scripts/register-commands.mjs, scripts/command-schema.mjs, scripts/deploy-and-announce.sh, scripts/announce-deploy.mjs]
  symbols: [commands]
  test_paths: [test/command-registration.spec.ts, test/helpers.ts]
  validation_commands: [npm run typecheck]
---

# Local development, command registration, and deployment

The Worker is configured in `wrangler.jsonc` and starts from `src/index.ts`; architectural boundaries are in [Worker architecture](architecture-overview.md). Use `.dev.vars.example` as the local template and keep real `.dev.vars` out of source control and documentation. Production values are Worker secret bindings; tracked timing values remain in Wrangler configuration.

## Everyday commands

| Intent | Command | Scope |
| --- | --- | --- |
| Local Worker | `npm run dev` | Starts Wrangler development. Requires intentionally configured local bindings for live integrations. |
| Focused tests | `npm test -- --run <test files>` | Prefer the narrow suites named in the linked wiki page. |
| All tests | `npm test -- --run` | Conditional broader check before release or cross-cutting changes. |
| Static check | `npm run typecheck` | Runs TypeScript checks for source and test projects. |
| Refresh Worker env types | `npm run cf-typegen` | Required after Wrangler binding changes; updates generated `worker-configuration.d.ts`. |
| Deploy | `npm run deploy` | Runs `wrangler deploy`; use after focused validation. |

Vitest uses the Cloudflare Workers pool with `src/index.ts` as its Worker entrypoint. The configuration deliberately does not read local `.dev.vars`: deterministic mock credentials and upstream fixtures come from test helpers. This is why a focused test should not need live external services.

## Discord command registration

`scripts/command-schema.mjs` is the canonical registration payload for `/search` (general/movie/TV), `/add`, and `/status`. `scripts/register-commands.mjs` bulk-overwrites **guild-scoped** commands using application ID, guild ID, and bot token loaded by the npm script's `node --env-file-if-exists=.dev.vars`. Registering is idempotent; unregistering bulk-overwrites with an empty list. Neither operation touches global commands and neither prints credential values.

Command behavior is owned by [Discord interactions](discord-interactions.md#ingress-and-callback-lifecycle) and [search/media](search-and-media.md). When adding a command, update the schema and runtime dispatcher together, test both sides, then register only in an intended development guild:

```sh
npm test -- --run test/command-registration.spec.ts test/discord.spec.ts
npm run discord:register
```

The second command is a consumer-facing integration action, not an ordinary unit-test substitute. Use `npm run discord:unregister` only when intentionally removing all commands from that configured guild.

## Deployment chain

`npm run deploy` only deploys. `scripts/deploy-and-announce.sh` is the release chain: it runs all tests, typechecks, deploys, collects current commit/summary/repository metadata, then invokes `announce-deploy.mjs`. The announcement script requires its webhook configuration, posts a mention-safe payload, and fails on non-success status. It is therefore a conditional release operation—not needed for a code-only local validation.

## Change navigation

| Change | Start at | Minimal validation | Conditional follow-up |
| --- | --- | --- | --- |
| Worker binding | `wrangler.jsonc`, `.dev.vars.example`, `src/config.ts` | `npm test -- --run test/config.spec.ts && npm run typecheck` | `npm run cf-typegen` when binding declarations change. |
| Command schema | `scripts/command-schema.mjs`, `src/discord/interactions.ts` | `npm test -- --run test/command-registration.spec.ts test/discord.spec.ts` | `npm run discord:register` to exercise the real guild registration boundary. |
| Deployment tooling | `scripts/deploy-and-announce.sh`, `scripts/announce-deploy.mjs` | Review shell/script contract; run tests affected by changes | Full release chain only in a release context with required configuration. |
| Cross-cutting release | linked focused suites plus `npm run typecheck` | `npm test -- --run` | `npm run deploy` only after production configuration is ready. |

Do not hand-edit generated worker types. Avoid documenting or emitting live configuration values, bot tokens, API keys, webhook URLs, or local environment contents.