import { Context } from 'hono';
import { songWrite } from './cf';
import { aisgAuthHeaders } from './aisonggenerator';
import { ProviderError, isTimeoutError } from './errors';
import { hasUnexpectedChinese } from './language';

// Define the unified response type
export interface UnifiedLyricsResponse {
	title: string;
	lyrics: string;
	style: string[];
	service: string;
}

type LyricsFailureReason =
	| 'auth_error'
	| 'http_error'
	| 'timeout'
	| 'network_error'
	| 'invalid_payload'
	| 'unexpected_chinese'
	| 'all_models_failed'
	| 'service_failed';

class LyricsServiceError extends Error {
	readonly reason: LyricsFailureReason;
	readonly upstreamStatus?: number;

	constructor(reason: LyricsFailureReason, upstreamStatus?: number) {
		super(reason);
		this.name = 'LyricsServiceError';
		this.reason = reason;
		this.upstreamStatus = upstreamStatus;
	}
}

// Service definition for cleaner iteration
interface LyricsService {
	name: 'aisonggenerator.io' | 'cloudflare-ai';
	fetch: (prompt: string, env: Env) => Promise<UnifiedLyricsResponse>;
}

export const AISG_LYRICS_MAX_ATTEMPTS = 3;
export const MIN_STYLE_TAGS = 2;

const LANGUAGE_RETRY_REMINDER =
	'\n\nIMPORTANT: Write the title, lyrics, and style tags strictly in the exact language of the prompt above. Do not switch to another language.';

async function fetchAisgLyricsOnce(prompt: string, env: Env): Promise<UnifiedLyricsResponse> {
	let headers: HeadersInit;
	try {
		headers = aisgAuthHeaders(env, true);
	} catch {
		throw new LyricsServiceError('auth_error');
	}

	let res: Response;
	try {
		res = await fetch('https://aisonggenerator.io/api/music/lyrics/generate', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				action: 'generate',
				model: 'openrouter/auto',
				prompt,
			}),
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		throw new LyricsServiceError(isTimeoutError(error) ? 'timeout' : 'network_error');
	}

	if (!res.ok) {
		throw new LyricsServiceError(res.status === 401 || res.status === 403 ? 'auth_error' : 'http_error', res.status);
	}

	const response = (await res.json().catch(() => null)) as {
		title?: unknown;
		lyrics?: unknown;
		tags?: unknown;
		style?: unknown;
	} | null;
	const tagText =
		typeof response?.tags === 'string'
			? response.tags
			: typeof response?.style === 'string'
				? response.style
				: '';
	const style = tagText
		.split(',')
		.map((item: string) => item.trim())
		.filter(Boolean);
	if (
		typeof response?.lyrics === 'string' &&
		response.lyrics.trim() &&
		typeof response.title === 'string' &&
		response.title.trim() &&
		style.length >= MIN_STYLE_TAGS
	) {
		return {
			title: response.title.trim(),
			service: 'aisonggenerator.io',
			lyrics: response.lyrics.trim(),
			style,
		};
	}
	throw new LyricsServiceError('invalid_payload');
}

const lyricsServices: LyricsService[] = [
	{
		name: 'aisonggenerator.io',
		fetch: async (prompt, env) => {
			for (let attempt = 1; attempt <= AISG_LYRICS_MAX_ATTEMPTS; attempt++) {
				const attemptPrompt = attempt === 1 ? prompt : `${prompt}${LANGUAGE_RETRY_REMINDER}`;
				const result = await fetchAisgLyricsOnce(attemptPrompt, env);
				if (!hasUnexpectedChinese(prompt, result)) {
					return result;
				}
				console.warn(
					JSON.stringify({
						event: 'aisg_lyrics_unexpected_chinese',
						attempt,
						max_attempts: AISG_LYRICS_MAX_ATTEMPTS,
					})
				);
			}
			throw new LyricsServiceError('unexpected_chinese');
		},
	},
	{
		name: 'cloudflare-ai',
		fetch: async (prompt, env) => {
			try {
				return { ...(await songWrite(env, prompt)), service: 'cloudflare-ai' };
			} catch {
				throw new LyricsServiceError('all_models_failed');
			}
		},
	},
];

function invalidLyricsRequest(message: string): ProviderError {
	return new ProviderError(message, {
		status: 400,
		provider: 'lyrics',
		code: 'invalid_request',
		retryable: false,
		outcome: 'rejected',
	});
}

function classifyLyricsFailure(error: unknown): { reason: LyricsFailureReason; upstreamStatus?: number } {
	if (error instanceof LyricsServiceError) {
		return { reason: error.reason, upstreamStatus: error.upstreamStatus };
	}
	if (isTimeoutError(error)) {
		return { reason: 'timeout' };
	}
	return { reason: 'service_failed' };
}

export async function generateLyricsWithFallback(prompt: string, env: Env): Promise<UnifiedLyricsResponse> {
	const trimmedPrompt = prompt.trim();
	if (!trimmedPrompt) {
		throw invalidLyricsRequest('Prompt is required');
	}

	const failures: Array<{ service: string; reason: LyricsFailureReason; upstream_status?: number }> = [];

	for (const service of lyricsServices) {
		try {
			const result = await service.fetch(trimmedPrompt, env);
			return result;
		} catch (error) {
			const detail = classifyLyricsFailure(error);
			const entry = {
				service: service.name,
				reason: detail.reason,
				...(detail.upstreamStatus !== undefined ? { upstream_status: detail.upstreamStatus } : {}),
			};
			console.warn(JSON.stringify({ event: 'lyrics_service_failed', ...entry }));
			failures.push(entry);
		}
	}

	console.error(JSON.stringify({ event: 'lyrics_all_services_failed', failures }));
	throw new ProviderError('All lyric generation services failed', {
		status: 503,
		provider: 'lyrics',
		code: 'lyrics_unavailable',
		retryable: true,
		outcome: 'rejected',
	});
}

export async function lyrics(ctx: Context<{ Bindings: Env }>) {
	const contentType = (ctx.req.header('content-type') || '').toLowerCase();
	const isDeclaredJson = contentType.includes('application/json') || contentType.includes('+json');
	const requestBody = await ctx.req.text();
	let prompt = '';

	if (isDeclaredJson) {
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(requestBody);
		} catch {
			throw invalidLyricsRequest('Invalid JSON request body');
		}
		if (
			!parsedBody ||
			typeof parsedBody !== 'object' ||
			Array.isArray(parsedBody) ||
			typeof (parsedBody as { prompt?: unknown }).prompt !== 'string'
		) {
			throw invalidLyricsRequest("JSON request body must include a string 'prompt'");
		}
		prompt = (parsedBody as { prompt: string }).prompt;
	} else if (requestBody.trim()) {
		// Preserve raw-text lyrics callers (e.g. text/plain or omitted Content-Type),
		// while still accepting valid JSON objects sent without a JSON Content-Type header.
		try {
			const parsedBody: unknown = JSON.parse(requestBody);
			if (
				parsedBody &&
				typeof parsedBody === 'object' &&
				!Array.isArray(parsedBody) &&
				typeof (parsedBody as { prompt?: unknown }).prompt === 'string'
			) {
				prompt = (parsedBody as { prompt: string }).prompt;
			} else {
				prompt = requestBody;
			}
		} catch {
			prompt = requestBody;
		}
	}

	const result = await generateLyricsWithFallback(prompt, ctx.env);
	return ctx.json(result);
}
