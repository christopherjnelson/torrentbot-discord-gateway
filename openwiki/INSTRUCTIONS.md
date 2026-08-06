# TorrentBot documentation brief

Generate concise, source-grounded documentation for this TypeScript Cloudflare
Worker. Prioritize information that helps maintainers understand and safely
change the production system:

- the Worker entry point, HTTP routing, configuration, and runtime boundaries;
- Discord request verification, deferred responses, component signing, and the
  movie, TV, general-search, add-torrent, and status workflows;
- the TMDB, Prowlarr, TorBox, and Discord API integrations and their data flow;
- authentication, guild authorization, secret handling, validation, timeouts,
  error mapping, and other security or reliability boundaries;
- tests, local development, Discord command registration, and deployment.

Describe only behavior supported by the repository. Clearly distinguish the
Discord interaction routes from the bearer-authenticated internal API. Use
Mermaid diagrams where they materially clarify architecture or multi-step
flows. Never reproduce credential values, local environment contents, private
URLs, user-specific filesystem paths, or other secrets.
