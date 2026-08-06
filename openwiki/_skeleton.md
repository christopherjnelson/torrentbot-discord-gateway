---
type: Reference
title: TorrentBot documentation coverage inventory
description: Initial source-grounded inventory used to establish the TorrentBot maintainer wiki and identify its canonical documentation areas.
tags: [repository, inventory]
openwiki:
  roles: [repository]
---

# TorrentBot documentation coverage inventory

This initial inventory is retained as a compact reference for the canonical documentation set. Start with [the maintainer quickstart](quickstart.md), which links each topic to its source entry points and focused checks.

| System | Canonical documentation |
| --- | --- |
| Worker routing, runtime boundary, and health endpoint | [Worker architecture](architecture-overview.md) |
| Discord verification, callbacks, and signed components | [Discord interactions](discord-interactions.md) |
| Bearer-authenticated automation endpoints | [Internal API](internal-api.md) |
| General, movie, and TV release search | [Search and media](search-and-media.md) |
| TorBox submission, readiness, links, and status | [Torrent management](torrent-management.md) |
| External adapter and normalization contracts | [Upstream integrations](upstream-integrations.md) |
| Configuration safety, authorization, and errors | [Security and reliability](security-and-reliability.md) |
| Local development, registration, and deployment | [Development and deployment](development-and-deployment.md) |

The Worker has no separate persistence, queue, or background-monitoring subsystem in the inspected configuration. Long-running work is limited to request-scoped `ExecutionContext.waitUntil` continuations; selected-release polling is deliberately bounded and `/status` is the later-check path.