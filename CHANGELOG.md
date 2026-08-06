# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add typed `/search general`, `/search movie`, and `/search tv` subcommands.
- Add TMDB movie and TV disambiguation before querying Prowlarr.
- Add TV season selection and guided back/cancel controls for media searches.

### Changed
- Show loading and progress responses while resolving media selections and
  searching Prowlarr releases.
- Prefer the single primary movie or TV file when a release's remaining files
  are recognizable samples, subtitles, metadata, checksums, or artwork; retain
  ZIP downloads for season packs, multipart archives, and ambiguous releases.
- Expand the automated regression suite from 245 to 315 passing tests.

### Fixed
- Restore TV season selection after choosing a TMDB series.
- Preserve the configured Prowlarr URL across the redesigned media workflow.
- Keep progress presentation visible after movie selection and during release
  searches.

## [0.1.0-beta.1] - 2026-07-20

### Added
- **Slash Commands**:
  - `/search`: Searches self-hosted Prowlarr instances with up to 10 selectable results and advisory `⚡ Cached` badges checking TorBox cache status in one batch.
  - `/add`: Submits a magnet URI directly to TorBox with automated duplicate recovery.
  - `/status`: Lists active TorBox downloads with temporary, authenticated direct or zip archive download links for completed torrents.
- **Security & Authorization**:
  - Implemented strict guild-scoped command and interaction authorization via `TORBOX_ALLOWED_GUILD_IDS`.
  - Added signed interactive components (select menus) using HMAC-SHA-256 with requester binding and 15-minute expiration to prevent multi-user tampering.
  - Built secure proxy-URL defense (Prowlarr credential stripping/re-construction) and zero-logging rules for sensitive tokens and magnet/download URLs.
- **Internal API**: Robust, authenticated API endpoints (`POST /api/search`, `POST /api/torrents`, `GET /api/torrents/:id`) for external automation (e.g. n8n).
- **Agent Integration**: Comprehensive **Agent Skills** guidelines documenting Prowlarr and TorBox API contracts, rules, and safety parameters.
- **Quality Assurance**:
  - A comprehensive suite of 245 unit and integration tests with Vitest inside a real simulated Workers environment (`@cloudflare/vitest-pool-workers`).
  - Full TypeScript type safety throughout the codebase.
  - Native Cloudflare Workers deployment configuration.
