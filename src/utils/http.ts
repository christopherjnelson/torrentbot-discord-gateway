import {
	UpstreamNetworkError,
	UpstreamTimeoutError,
	type UpstreamService,
} from "./errors";

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchTextOptions {
	/** Abort the upstream request after this many milliseconds. */
	timeoutMs?: number;
	/** Used for error classification only; never embedded in request URLs. */
	service: UpstreamService;
	headers?: Record<string, string>;
	method?: string;
	body?: BodyInit;
}

/**
 * fetch() with a hard timeout and normalized errors.
 *
 * Never throws the raw fetch error: network/abort failures are converted to
 * UpstreamNetworkError / UpstreamTimeoutError so no request URL (which may
 * carry credentials in query strings) can leak through error messages.
 */
export async function fetchText(
	url: string,
	options: FetchTextOptions,
): Promise<{ status: number; body: string }> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, service } = options;

	let response: Response;
	try {
		response = await fetch(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		// Check by name rather than instanceof: abort/timeout rejections may be
		// DOMExceptions from another realm (e.g. undici), which fail instanceof.
		const name = (error as { name?: unknown } | null)?.name;
		if (name === "TimeoutError" || name === "AbortError") {
			throw new UpstreamTimeoutError(service, timeoutMs);
		}
		throw new UpstreamNetworkError(service);
	}

	let body: string;
	try {
		body = await response.text();
	} catch {
		throw new UpstreamNetworkError(service);
	}

	return { status: response.status, body };
}
