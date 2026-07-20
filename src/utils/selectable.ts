/**
 * Selectable-result normalization for the `/search` select menu.
 *
 * This module is the single authority for turning raw Prowlarr results
 * into the exact array used by every downstream step of `/search`:
 *   1. the TorBox cache-check request,
 *   2. cache-status annotation,
 *   3. Discord select-menu options.
 *
 * The sequence is:
 *   Prowlarr results
 *   -> keep results with a valid 40-char BTIH info hash
 *   -> deduplicate by normalized (lowercased) info hash, first occurrence wins
 *   -> drop results whose sanitized label is empty/whitespace-only
 *   -> continue scanning later results until `cap` valid options are found
 *
 * It has no Discord-client or signing dependencies — only the
 * {@link TorrentResult} type, {@link isValidInfoHash}, and
 * {@link sanitizeInline} — so it can be unit-tested in isolation.
 */

import type { TorrentResult } from "../types/search";
import { isValidInfoHash } from "./signing";
import { sanitizeInline } from "./format";

/**
 * Keep results that carry a valid 40-character BTIH info hash, and
 * deduplicate them by normalized (lowercased) hash. First occurrence
 * wins; original order is preserved. No cap is applied.
 *
 * Returns a new array; the input is not mutated.
 */
export function getSelectableResults(
	results: readonly TorrentResult[],
): TorrentResult[] {
	const seen = new Set<string>();
	const out: TorrentResult[] = [];
	for (const result of results) {
		const hash = result.infoHash;
		if (typeof hash !== "string" || !isValidInfoHash(hash)) {
			continue;
		}
		const key = hash.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(result);
	}
	return out;
}

/**
 * Build the final selectable set for the Discord select menu.
 *
 * Starts from {@link getSelectableResults} (valid hashes, deduplicated by
 * normalized hash, original order preserved), then drops any result whose
 * sanitized label is empty/whitespace-only, continuing to scan later
 * results until `cap` valid options have been collected (or the input is
 * exhausted).
 *
 * The sanitized label is computed once here so callers do not need to
 * recompute it; the returned results are the original {@link TorrentResult}
 * objects (with `isCached` annotation applied later by the cache step).
 *
 * @param results  Raw Prowlarr results (any order; dedup is order-stable).
 * @param cap      Maximum number of selectable results to return
 *                 (e.g. {@link SELECT_OPTION_CAP}).
 * @returns        Deduplicated, label-filtered, capped selectable results.
 */
export function buildSelectableOptions(
	results: readonly TorrentResult[],
	cap: number,
): TorrentResult[] {
	const deduped = getSelectableResults(results);
	const out: TorrentResult[] = [];
	for (const result of deduped) {
		if (out.length >= cap) {
			break;
		}
		const label = sanitizeInline(result.title, 100);
		if (label.length === 0) {
			continue;
		}
		out.push(result);
	}
	return out;
}