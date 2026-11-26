import { Context } from 'hono';
import { CfLyricsAllModelsFailedError, songWrite } from './cf';
import { aisgAuthHeaders } from './aisonggenerator';
import { ProviderError, isTimeoutError } from './errors';
import { hasUnexpectedChinese } from './language';

export const AISG_LYRICS_MODEL = 'openrouter/auto';
const SMOL_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/;

export function extractSmolId(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	return SMOL_ID_RE.test(trimmed) ? trimmed : undefined;
}

export interface LyricsAttemptFailure {
	service: 'aisonggenerator.io' | 'cloudflare-ai';
	model?: string;
	reason: string;
	upstream_status?: number;
}

export interface LyricsGenerationMeta {
	service: 'aisonggenerator.io' | 'cloudflare-ai';
	model: string;
	aisg_attempts: number;
	cf_attempts: number;
	ms: number;
	fallbacks?: LyricsAttemptFailure[];
}

// Define the unified response type
export interface UnifiedLyricsResponse {
	title: string;
	lyrics: string;
	style: string[];
	service: string;
	model?: string;
	meta?: LyricsGenerationMeta;
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

export const AISG_LYRICS_MAX_ATTEMPTS = 3;
export const MIN_STYLE_TAGS = 2;
const AISG_LYRICS_BUDGET_MS = 19_000;

const LANGUAGE_RETRY_REMINDER =
	'\n\nIMPORTANT: Write the title, lyrics, and style tags strictly in the exact language of the prompt above. Do not switch to another language.';

async function fetchAisgLyricsOnce(prompt: string, env: Env, timeoutMs: number): Promise<UnifiedLyricsResponse> {
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
				model: AISG_LYRICS_MODEL,
				prompt,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new LyricsServiceError(isTimeoutError(error) ? 'timeout' : 'network_error');
	}

	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
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
			model: AISG_LYRICS_MODEL,
			lyrics: response.lyrics.trim(),
			style,
		};
	}
	throw new LyricsServiceError('invalid_payload');
}

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

function extractPromptSection(prompt: string): string | undefined {
	// Legacy workflow prompts indent their top-level headings.
	const [, section] = prompt.split(/^[\t ]*# Prompt[\t ]*(?:\r?\n|$)/m, 2);
	return section?.split(/^[\t ]*# /m, 1)[0];
}

export async function generateLyricsWithFallback(
	prompt: string,
	env: Env,
	userPrompt?: string,
	smolId?: string
): Promise<UnifiedLyricsResponse> {
	const trimmedPrompt = prompt.trim();
	if (!trimmedPrompt) {
		throw invalidLyricsRequest('Prompt is required');
	}
	const guardPrompt = userPrompt ?? extractPromptSection(trimmedPrompt) ?? trimmedPrompt;
	const startedAt = Date.now();

	const serviceFailures: Array<{ service: string; reason: LyricsFailureReason; upstream_status?: number }> = [];
	const attemptFailures: LyricsAttemptFailure[] = [];
	let aisgAttempts = 0;
	let cfAttempts = 0;

	// 1) Primary: aisonggenerator.io
	try {
		// Reserve up to 25 seconds for Workers AI within the workflow's 45-second request timeout.
		const deadline = Date.now() + AISG_LYRICS_BUDGET_MS;
		for (let attempt = 1; attempt <= AISG_LYRICS_MAX_ATTEMPTS; attempt++) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new LyricsServiceError('timeout');
			}
			aisgAttempts++;
			const attemptPrompt = attempt === 1 ? trimmedPrompt : `${trimmedPrompt}${LANGUAGE_RETRY_REMINDER}`;
			const result = await fetchAisgLyricsOnce(attemptPrompt, env, Math.min(10_000, remainingMs));
			if (!hasUnexpectedChinese(guardPrompt, result)) {
				const ms = Date.now() - startedAt;
				const meta: LyricsGenerationMeta = {
					service: 'aisonggenerator.io',
					model: AISG_LYRICS_MODEL,
					aisg_attempts: aisgAttempts,
					cf_attempts: 0,
					ms,
					...(attemptFailures.length > 0 ? { fallbacks: attemptFailures } : {}),
				};
				console.log(
					JSON.stringify({
						event: 'lyrics_generated',
						...(smolId ? { smol_id: smolId } : {}),
						service: meta.service,
						model: meta.model,
						aisg_attempts: meta.aisg_attempts,
						cf_attempts: meta.cf_attempts,
						fallback_count: attemptFailures.length,
						ms,
					})
				);
				return {
					...result,
					model: AISG_LYRICS_MODEL,
					meta,
				};
			}
			attemptFailures.push({
				service: 'aisonggenerator.io',
				model: AISG_LYRICS_MODEL,
				reason: 'unexpected_chinese',
			});
			console.warn(
				JSON.stringify({
					event: 'aisg_lyrics_unexpected_chinese',
					...(smolId ? { smol_id: smolId } : {}),
					attempt,
					max_attempts: AISG_LYRICS_MAX_ATTEMPTS,
				})
			);
		}
		throw new LyricsServiceError('unexpected_chinese');
	} catch (error) {
		const detail = classifyLyricsFailure(error);
		if (detail.reason !== 'unexpected_chinese') {
			attemptFailures.push({
				service: 'aisonggenerator.io',
				model: AISG_LYRICS_MODEL,
				reason: detail.reason,
				...(detail.upstreamStatus !== undefined ? { upstream_status: detail.upstreamStatus } : {}),
			});
		}
		const entry = {
			service: 'aisonggenerator.io',
			reason: detail.reason,
			...(detail.upstreamStatus !== undefined ? { upstream_status: detail.upstreamStatus } : {}),
		};
		console.warn(JSON.stringify({ event: 'lyrics_service_failed', ...(smolId ? { smol_id: smolId } : {}), ...entry }));
		serviceFailures.push(entry);
	}

	// 2) Fallback: Cloudflare Workers AI
	try {
		const cfResult = await songWrite(env, trimmedPrompt, guardPrompt, smolId);
		cfAttempts = cfResult.attempts;
		for (const failure of cfResult.failures) {
			attemptFailures.push({
				service: 'cloudflare-ai',
				model: failure.model,
				reason: failure.reason,
			});
		}
		const ms = Date.now() - startedAt;
		const meta: LyricsGenerationMeta = {
			service: 'cloudflare-ai',
			model: cfResult.model,
			aisg_attempts: aisgAttempts,
			cf_attempts: cfAttempts,
			ms,
			...(attemptFailures.length > 0 ? { fallbacks: attemptFailures } : {}),
		};
		console.log(
			JSON.stringify({
				event: 'lyrics_generated',
				...(smolId ? { smol_id: smolId } : {}),
				service: meta.service,
				model: meta.model,
				aisg_attempts: meta.aisg_attempts,
				cf_attempts: meta.cf_attempts,
				fallback_count: attemptFailures.length,
				ms,
			})
		);
		return {
			title: cfResult.title,
			lyrics: cfResult.lyrics,
			style: cfResult.style,
			service: 'cloudflare-ai',
			model: cfResult.model,
			meta,
		};
	} catch (error) {
		if (error instanceof CfLyricsAllModelsFailedError) {
			cfAttempts = error.attempts;
			for (const failure of error.failures) {
				attemptFailures.push({
					service: 'cloudflare-ai',
					model: failure.model,
					reason: failure.reason,
				});
			}
		}
		const entry = {
			service: 'cloudflare-ai',
			reason: 'all_models_failed' as const,
		};
		console.warn(JSON.stringify({ event: 'lyrics_service_failed', ...(smolId ? { smol_id: smolId } : {}), ...entry }));
		serviceFailures.push(entry);
	}

	console.error(
		JSON.stringify({
			event: 'lyrics_all_services_failed',
			...(smolId ? { smol_id: smolId } : {}),
			aisg_attempts: aisgAttempts,
			cf_attempts: cfAttempts,
			failures: serviceFailures,
			ms: Date.now() - startedAt,
		})
	);
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
	const smolId = extractSmolId(ctx.req.header('x-smol-id'));
	const requestBody = await ctx.req.text();
	let prompt = requestBody;
	let userPrompt: string | undefined;

	// Preserve raw text and accept JSON objects sent without a JSON Content-Type header.
	if (isDeclaredJson || requestBody.trim()) {
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(requestBody);
		} catch {
			if (isDeclaredJson) {
				throw invalidLyricsRequest('Invalid JSON request body');
			}
		}
		if (
			parsedBody &&
			typeof parsedBody === 'object' &&
			!Array.isArray(parsedBody) &&
			'prompt' in parsedBody &&
			typeof parsedBody.prompt === 'string'
		) {
			prompt = parsedBody.prompt;
			if ('user_prompt' in parsedBody && typeof parsedBody.user_prompt === 'string') {
				userPrompt = parsedBody.user_prompt;
			}
		} else if (isDeclaredJson) {
			throw invalidLyricsRequest("JSON request body must include a string 'prompt'");
		}
	}

	const result = await generateLyricsWithFallback(prompt, ctx.env, userPrompt, smolId);
	return ctx.json(result);
}
