import { isTimeoutError } from './errors';
import { hasUnexpectedChinese } from './language';

export const PRIMARY_LYRICS_MODEL = '@cf/zai-org/glm-5.3';
export const SECONDARY_LYRICS_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
export const FALLBACK_LYRICS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CF_LYRICS_BUDGET_MS = 25_000;

export const SONGWRITER_SYSTEM_PROMPT = `You are a skilled, versatile songwriter and music producer writing songs for an AI music generator.

CORE RULES:
1. Match the user's tone and intent faithfully (earnest, melancholic, gritty, playful, comedic, romantic, or weird). Never force comedy onto serious prompts.
2. Treat "# Prompt" as authoritative (topic, genre, mood, language, specific details). Treat "# Description" (cover art) only as optional visual color — ignore anything in the description that clashes with the prompt, and NEVER mention pixels, pixel art, or images unless the user explicitly asked for it.
3. LANGUAGE: Write the title, lyrics, and style tags in the EXACT language of "# Prompt", unless "# Prompt" explicitly requests another language or a bilingual mix. Never randomly switch languages.

LYRIC CRAFT:
- Write lyrics meant to be SUNG aloud: tight phrasing, natural cadence, vivid concrete imagery, internal rhymes and slant rhymes rather than clunky forced rhymes.
- Build a sticky, repeatable [Chorus] hook — repeat the same core chorus lines verbatim so the song has a memorable hook.
- Keep songs tight and focused: roughly 2 verses, 2 choruses, an optional pre-chorus or bridge, and a short intro/outro (24-38 sung lines total).
- Use ONLY clean bracketed section tags like [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]. Never put JSON or metadata blobs inside brackets.
- NEVER write parenthetical translations, glosses, or sound-effect/stage directions in ( ) — anything in parentheses may be sung aloud, so reserve ( ) strictly for short sung ad-libs like (yeah) or (ooh).
- Avoid tired AI lyric clichés ("neon lights", "shadows dancing", "whispers in the dark", "echoes in the night", "symphony of", "heart racing", "steals the show", "pixel", "digital world") unless the prompt specifically asks for them.
- If the prompt asks for an instrumental track, provide a fitting title and rich instrumental production tags in "style", and keep "lyrics" brief with clean instrumental section markers (e.g. [Intro], [Main Theme], [Bridge], [Outro]).

STYLE TAGS:
- Return 4 to 7 concrete, specific musical production tags in "style" covering: primary genre/subgenre, standout instruments/textures, vocal character (or "instrumental"), tempo/groove feel, and mood.
- Never return a long list of generic mood adjectives.

Return ONLY valid JSON matching {"title": string, "lyrics": string, "style": string[]}.`;

export interface SongWriteResult {
	title: string;
	lyrics: string;
	style: string[];
}

type CfLyricsFailureReason =
	| 'invalid_json'
	| 'invalid_schema'
	| 'insufficient_style_tags'
	| 'unexpected_chinese'
	| 'timeout'
	| 'spend_limit'
	| 'binding_error';

class CfLyricsValidationError extends Error {
	readonly reason: CfLyricsFailureReason;

	constructor(message: string, reason: CfLyricsFailureReason) {
		super(message);
		this.name = 'CfLyricsValidationError';
		this.reason = reason;
	}
}

export function extractModelDraft(result: unknown): unknown {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const envelope = (result as { result?: unknown }).result;
	const source = (envelope && typeof envelope === 'object' ? envelope : result) as {
		response?: unknown;
		choices?: Array<{ message?: { content?: unknown } }>;
	};
	const choiceContent = source.choices?.[0]?.message?.content;
	if (typeof choiceContent === 'string' && choiceContent.trim()) {
		return choiceContent;
	}
	if (source.response !== undefined) {
		return source.response;
	}
	return undefined;
}

export function parseAndValidateSong(raw: unknown, guardPrompt: string): SongWriteResult {
	let draft = raw;
	if (typeof draft === 'string') {
		const cleaned = draft.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
		try {
			draft = JSON.parse(cleaned);
		} catch {
			const start = cleaned.indexOf('{');
			const end = cleaned.lastIndexOf('}');
			if (start >= 0 && end > start) {
				try {
					draft = JSON.parse(cleaned.slice(start, end + 1));
				} catch {
					throw new CfLyricsValidationError('Cloudflare AI returned invalid JSON', 'invalid_json');
				}
			} else {
				throw new CfLyricsValidationError('Cloudflare AI returned invalid JSON', 'invalid_json');
			}
		}
	}

	const song = draft as { title?: unknown; lyrics?: unknown; style?: unknown } | null;
	if (
		typeof song?.title !== 'string' ||
		!song.title.trim() ||
		typeof song.lyrics !== 'string' ||
		!song.lyrics.trim() ||
		!Array.isArray(song.style) ||
		!song.style.every((tag) => typeof tag === 'string')
	) {
		throw new CfLyricsValidationError('Cloudflare AI response does not match the lyrics schema', 'invalid_schema');
	}

	const normalized: SongWriteResult = {
		title: song.title.trim(),
		lyrics: song.lyrics.trim(),
		style: song.style.map((tag) => tag.trim()).filter(Boolean),
	};

	if (normalized.style.length < 2) {
		throw new CfLyricsValidationError(
			'Cloudflare AI response returned fewer than 2 style tags',
			'insufficient_style_tags'
		);
	}

	if (hasUnexpectedChinese(guardPrompt, normalized)) {
		throw new CfLyricsValidationError('Cloudflare AI returned unexpected Chinese output', 'unexpected_chinese');
	}

	return normalized;
}

type LyricsModel = typeof PRIMARY_LYRICS_MODEL | typeof SECONDARY_LYRICS_MODEL | typeof FALLBACK_LYRICS_MODEL;

function runLyricsModel<Model extends LyricsModel>(
	env: Env,
	model: Model,
	input: AiModels[Model]['inputs'],
	signal: AbortSignal
) {
	const gatewayId = env.CF_AI_GATEWAY_ID?.trim();
	return gatewayId
		? env.AI.run(model, input, { gateway: { id: gatewayId }, signal })
		: env.AI.run(model, input);
}

function runGlm53(env: Env, prompt: string, signal: AbortSignal) {
	return runLyricsModel(
		env,
		PRIMARY_LYRICS_MODEL,
		{
			messages: [
				{ role: 'system', content: SONGWRITER_SYSTEM_PROMPT },
				{ role: 'user', content: prompt },
			],
			max_completion_tokens: 2600,
			temperature: 0.75,
			reasoning_effort: 'low',
			response_format: { type: 'json_object' },
		},
		signal
	);
}

function runDeepSeekFlash(env: Env, prompt: string, signal: AbortSignal) {
	return runLyricsModel(
		env,
		SECONDARY_LYRICS_MODEL,
		{
			messages: [
				{ role: 'system', content: SONGWRITER_SYSTEM_PROMPT },
				{ role: 'user', content: prompt },
			],
			max_completion_tokens: 1600,
			temperature: 0.75,
			reasoning_effort: 'none',
			response_format: { type: 'json_object' },
		},
		signal
	);
}

function runLlama33Fallback(env: Env, prompt: string, signal: AbortSignal) {
	return runLyricsModel(
		env,
		FALLBACK_LYRICS_MODEL,
		{
			messages: [
				{ role: 'system', content: SONGWRITER_SYSTEM_PROMPT },
				{ role: 'user', content: prompt },
			],
			max_tokens: 1400,
			temperature: 0.75,
			response_format: {
				type: 'json_schema',
				json_schema: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						lyrics: { type: 'string' },
						style: {
							type: 'array',
							items: { type: 'string' },
						},
					},
					required: ['title', 'lyrics', 'style'],
				},
			},
		},
		signal
	);
}

const cfLyricsRunners = [
	{ model: PRIMARY_LYRICS_MODEL, run: runGlm53 },
	{ model: SECONDARY_LYRICS_MODEL, run: runDeepSeekFlash },
	{ model: FALLBACK_LYRICS_MODEL, run: runLlama33Fallback },
];

function classifyCfFailureReason(error: unknown): CfLyricsFailureReason {
	if (error instanceof CfLyricsValidationError) {
		return error.reason;
	}
	if (isTimeoutError(error)) {
		return 'timeout';
	}
	if (error instanceof Error) {
		const detail = `${error.name}: ${error.message}`;
		if (
			/\bAiGatewayError:\s*(?:(?:2021|2052)\b|.*\bspend(?:ing)? limit\b.*\b(?:exceeded|reached)\b)/i.test(detail) ||
			/\bAiError:\s*3036\b/.test(detail)
		) {
			return 'spend_limit';
		}
	}
	return 'binding_error';
}

export async function songWrite(env: Env, prompt: string, guardPrompt = prompt): Promise<SongWriteResult> {
	const deadline = Date.now() + CF_LYRICS_BUDGET_MS;
	for (const [index, runner] of cfLyricsRunners.entries()) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}

		// Share the remaining time so an unresponsive model cannot starve later fallbacks.
		const budgetMs = Math.floor(remainingMs / (cfLyricsRunners.length - index));
		const controller = new AbortController();
		const timeoutError = new DOMException('Cloudflare AI lyrics model timed out', 'TimeoutError');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(timeoutError);
					controller.abort(timeoutError);
				}, budgetMs);
			});
			const draft = await Promise.race([runner.run(env, prompt, controller.signal), timeout]);
			const result = parseAndValidateSong(extractModelDraft(draft), guardPrompt);
			if (Date.now() >= deadline) {
				throw timeoutError;
			}
			return result;
		} catch (error) {
			const reason = classifyCfFailureReason(error);
			console.warn(
				JSON.stringify({
					event: 'cf_ai_lyrics_failed',
					model: runner.model,
					reason,
				})
			);
			if (reason === 'spend_limit') {
				break;
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error('All Cloudflare AI lyrics models failed');
}
