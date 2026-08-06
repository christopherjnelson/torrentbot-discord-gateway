---
okf_version: "0.1"
---

# Files

- [TorrentBot documentation coverage inventory](_skeleton.md) - Initial source-grounded inventory used to establish the TorrentBot maintainer wiki and identify its canonical documentation areas.
- [Worker architecture and runtime boundaries](architecture-overview.md) - Cloudflare Worker dispatch, the separation between Discord interactions and the internal API, and the shared runtime configuration boundary.
- [Local development, command registration, and deployment](development-and-deployment.md) - Safe local Worker development, deterministic test setup, Discord guild command registration, generated types, and deployment automation.
- [Discord interaction ingress and signed component lifecycle](discord-interactions.md) - Verified Discord webhook processing, callback and follow-up lifecycle, command dispatch, and stateless signed component safety rules.
- [Bearer-authenticated internal API](internal-api.md) - Internal automation endpoints for Prowlarr search and TorBox torrent operations, including authentication, validation, safe serialization, and error mapping.
- [TorrentBot maintainer quickstart](quickstart.md) - Entry point for maintaining the TypeScript Cloudflare Worker, with system map, task routing, focused tests, and operational boundaries.
- [Discord search, movie, and TV media workflow](search-and-media.md) - Guild-authorized general, movie, and TV search from Discord through TMDB disambiguation, Prowlarr release search, and signed continuation controls.
- [Configuration, authorization, and reliability boundaries](security-and-reliability.md) - Runtime secret handling, guild and bearer authorization, validation, timeout, error, logging, and ephemeral-output constraints for the Worker.
- [TorBox submission, readiness, and status workflow](torrent-management.md) - Authorized Discord add, selected-release, polling, temporary-link, and status behavior over a shared TorBox account.
- [Upstream service adapters and safe data boundaries](upstream-integrations.md) - Prowlarr, TMDB, TorBox, and Discord follow-up integration contracts, normalization behavior, transport timeouts, and credential-safe errors.
