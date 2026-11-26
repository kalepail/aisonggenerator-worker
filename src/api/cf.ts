import { isTimeoutError } from './errors';
import { hasUnexpectedChinese } from './language';

export const PRIMARY_LYRICS_MODEL = 'anthropic/claude-fable-5.2';
export const SECONDARY_LYRICS_MODEL = 'anthropic/claude-opus-5.5';
export const TERTIARY_LYRICS_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
export const FALLBACK_LYRICS_MODEL = '@cf/zai-org/glm-5.3';

// Total budget across the Cloudflare AI / Unified Billing fallback chain (fits inside smol-workflow's 55s fetch timeout).
export const CF_LYRICS_BUDGET_MS = 48_000;
const RESERVE_NATIVE_FALLBACK_MS = 12_000;

export const LYRICS_JSON_SCHEMA = {
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
	additionalProperties: false,
} as const;

export const SONGWRITER_SYSTEM_PROMPT = `You are an acclaimed human songwriter, lyricist, and record producer writing release-ready songs for an AI music engine (Suno/AISG v6 and ElevenLabs Music v2.5). Your goal is lyrics so sharp, specific, musical, and alive that a listener assumes a real artist wrote them.

BEFORE WRITING (plan silently, do not print):
1. Engine & Angle:
   - If "# Prompt" is short or open-ended, commit to ONE specific dramatic moment, object, contradiction, or joke that makes the song unmistakable — never write a broad summary of the topic.
   - If "# Prompt" is detailed (specifying plot beats, characters, chorus lines, sections, or personal events), stay completely faithful to the user's world and cover EVERY key beat rather than inventing an unrelated side-story.
2. Section Jobs: Give each section a distinct job. Verse 1 sets the scene; Verse 2 advances the story, tension, or consequence (never recycles Verse 1); the Chorus compresses or reframes the emotion into a sticky, repeatable verbal hook; the Bridge turns the perspective, strips back, or reveals a cost — without turning into a speech that explains the song's thesis.
3. Sound & Register: Match the vocal delivery, rhythmic pocket, rhyme architecture, and lyrical scale to "# Prompt". Default to conversational understatement on open-ended prompts; when "# Prompt" explicitly asks for grand, theatrical, poetic, anthemic, or maximalist writing, deliver that scale through concrete imagery rather than hollow abstractions.

CORE FIDELITY RULES:
1. Honor every specific name, title, hook line, plot beat, tone, refusal, or exclusion in "# Prompt". Never rename characters or sanitize gritty, dark, absurd, or satirical prompts into motivational fluff.
2. Separate cover-art noise from lyrics: if "# Prompt" mixes visual appearance/art-direction notes (hair colors, watermarks, HDR lighting, pixel art, anime render style) with musical direction, treat visual notes as cover-art context — do NOT narrate hair colors, watermarks, pixels, 8-bit, or render terms in the sung lyrics unless "# Prompt" asks for the song to be about them. If "# Description" is present, treat it only as optional atmospheric color and ignore anything that clashes with "# Prompt".
3. LANGUAGE & SCRIPT: Write "title" and "lyrics" strictly in the target language(s) requested by "# Prompt" (defaulting to the language "# Prompt" is written in). If "# Prompt" requests a bilingual mix (e.g., half English / half Korean), maintain a genuine balanced mix throughout. Use natural, idiomatic phrasing native to the target language — never awkward literal translations. Always write "style" tags AND [Section] headings in concise ENGLISH (naming native genres/languages inside "style" where relevant, e.g., "French grunge pop", "Punjabi ghazal ballad").

SONGWRITING CRAFT (NON-NEGOTIABLE):
- Show through particulars, not abstract feelings: anchor verses in tangible objects, small gestures, places, timing, and overheard speech. Let the listener infer the feeling instead of announcing it.
- Write for the mouth and ear: match natural spoken word-stress to the beat, leave space for breath, and prefer singable phrasing over stiff prose. Never twist syntax ("Yoda-speak") just to land a rhyme.
- Break predictable rhyme monotony: DO NOT default to robotic AABB nursery-rhyme couplets or identical 4-line blocks. Mix ABAB, xAxA, slant rhymes, assonance, internal rhymes, multisyllabic rhymes (especially in rap/hip-hop), enjambment, and short punchy landing lines.
- Earn a sticky [Chorus]: build one memorable, repeatable hook phrase that hits on strong beats with singable vowels. Repeat the core chorus hook verbatim across choruses so the song feels like a real record, letting Verse 2 and the Bridge deepen what it means.
- Length calibration: Default to a tight, focused 26-42 sung lines on open-ended prompts. When "# Prompt" explicitly requests an extended structure, multiple solos, or a multi-beat narrative, expand cleanly up to ~55-75 sung lines (well under 5,000 characters) so every requested section and story beat lands cleanly.
- If the prompt asks for an instrumental track, provide a fitting title and rich instrumental production tags in "style", and keep "lyrics" brief with clean English instrumental section markers (e.g. [Intro], [Main Theme], [Bridge], [Outro]).

HARD ANTI-SLOP BAN:
- NEVER use overused AI lyric clichés unless "# Prompt" explicitly requests them or they are genuinely required by the user's specific setting: neon, shadows, echoes, whispers, crimson, velvet, symphony, tapestry, shatter, ember, ignite, unravel, flicker (of light/hope), digital, pixel, carousel, "spark in the dark", "ocean of night", "dancing in the dark", "steals the show", "heart racing", "chains breaking", "rise from the ashes", "here we go", or empty rhymes like fire/desire, night/light, heart/apart, sky/fly, soul/whole.
- Avoid stock indie/working-class AI defaults (e.g., "kitchen light" slow dances, "crayon drawing" of dad as a hero, "we're a family" lanyard clichés, or a stripped Bridge that merely summarizes the theme).
- NEVER force a generic "struggle -> inspiration -> triumph" arc unless the prompt asks for an anthem.

FORMATTING FOR AI MUSIC ENGINES:
- ALWAYS write bracketed section headings in ENGLISH on their own lines (e.g. [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Final Chorus], [Outro]) — even when the lyrics are in another language. Brief English performance/arrangement hints inside section brackets are allowed when helpful or requested by "# Prompt" (e.g. [Verse 1 - intimate, sparse], [Bridge - half-time, stripped back]).
- NEVER put stage directions, instrument solos, translations, or (No lyrics) inside parentheses ( ) — music models sing parentheses aloud! Reserve ( ) strictly for short sung backing vocals or ad-libs like (yeah) or (stay right here).
- Spell out awkward numbers/abbreviations as sung words when helpful (e.g. "two a.m." not "2AM").
- Never name real copyrighted artists, bands, or songs in "style" or "lyrics" unless explicitly in "# Prompt"; describe the sonic palette instead.

STYLE TAGS ("style" array — 5 to 7 concise ENGLISH tags, strictly ordered):
1. Primary genre/subgenre + era/feel (e.g. "90s French grunge pop", "gritty Memphis dirty trap", "warm indie soft rock")
2. Vocal character & delivery (include vocal gender ONLY if "# Prompt" specifies or clearly implies it; keep gender-neutral otherwise, e.g. "close conversational vocal" vs "smoky female alto, intimate phrasing")
3. 2-3 signature instruments & sonic textures (honor every instrument requested in "# Prompt")
4. Tempo / groove / pocket (honor any BPM/meter requested in "# Prompt")
5. Mix / production aesthetic & dynamic arc (e.g. "dry close-mic tape warmth, chorus opens wide with fuzz guitars")
Never dump generic mood-adjective soup.

Return ONLY valid raw JSON matching {"title": string, "lyrics": string, "style": string[]}.`;

export interface SongWriteResult {
	title: string;
	lyrics: string;
	style: string[];
}

export type CfLyricsFailureReason =
	| 'invalid_json'
	| 'invalid_schema'
	| 'insufficient_style_tags'
	| 'unexpected_chinese'
	| 'timeout'
	| 'spend_limit'
	| 'binding_error';

export type LyricsModel =
	| typeof PRIMARY_LYRICS_MODEL
	| typeof SECONDARY_LYRICS_MODEL
	| typeof TERTIARY_LYRICS_MODEL
	| typeof FALLBACK_LYRICS_MODEL;

export interface CfLyricsModelFailure {
	model: LyricsModel;
	reason: CfLyricsFailureReason;
}

export interface SongWriteDetailedResult extends SongWriteResult {
	model: LyricsModel;
	attempts: number;
	failures: CfLyricsModelFailure[];
}

export class CfLyricsAllModelsFailedError extends Error {
	readonly attempts: number;
	readonly failures: CfLyricsModelFailure[];

	constructor(attempts: number, failures: CfLyricsModelFailure[]) {
		super('All Cloudflare AI lyrics models failed');
		this.name = 'CfLyricsAllModelsFailedError';
		this.attempts = attempts;
		this.failures = failures;
	}
}

class CfLyricsValidationError extends Error {
	readonly reason: CfLyricsFailureReason;

	constructor(message: string, reason: CfLyricsFailureReason) {
		super(message);
		this.name = 'CfLyricsValidationError';
		this.reason = reason;
	}
}

export function isNativeWorkersAiModel(model: string): boolean {
	return model.startsWith('@cf/');
}

export function extractModelDraft(result: unknown): unknown {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const envelope = (result as { result?: unknown }).result;
	const source = (envelope && typeof envelope === 'object' ? envelope : result) as {
		response?: unknown;
		choices?: Array<{ message?: { content?: unknown } }>;
		content?: Array<{ type?: unknown; text?: unknown }>;
	};
	// Anthropic Messages format (Unified Billing via env.AI.run)
	if (Array.isArray(source.content)) {
		const textBlock = source.content.find(
			(block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()
		);
		if (textBlock && typeof textBlock.text === 'string') {
			return textBlock.text;
		}
	}
	// OpenAI-compatible Chat Completions format
	const choiceContent = source.choices?.[0]?.message?.content;
	if (typeof choiceContent === 'string' && choiceContent.trim()) {
		return choiceContent;
	}
	// Legacy Workers AI response format
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

	if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
		throw new CfLyricsValidationError('Cloudflare AI response does not match the lyrics schema', 'invalid_schema');
	}

	// Normalize trimmed/lowercase keys so minor tokenizer spacing quirks (e.g. `" style"`) never fail a valid song.
	const normalizedKeys: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(draft as Record<string, unknown>)) {
		normalizedKeys[k.trim().toLowerCase()] = v;
	}

	const rawTitle = normalizedKeys.title;
	const rawLyrics = normalizedKeys.lyrics;
	let rawStyle = normalizedKeys.style ?? normalizedKeys.styles;
	if (typeof rawStyle === 'string') {
		rawStyle = rawStyle
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
	}

	if (
		typeof rawTitle !== 'string' ||
		!rawTitle.trim() ||
		typeof rawLyrics !== 'string' ||
		!rawLyrics.trim() ||
		!Array.isArray(rawStyle) ||
		!rawStyle.every((tag) => typeof tag === 'string')
	) {
		throw new CfLyricsValidationError('Cloudflare AI response does not match the lyrics schema', 'invalid_schema');
	}

	const normalized: SongWriteResult = {
		title: rawTitle.trim(),
		lyrics: rawLyrics.trim(),
		style: rawStyle.map((tag) => tag.trim()).filter(Boolean),
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

function runAnthropicLyrics(
	env: Env,
	model: typeof PRIMARY_LYRICS_MODEL | typeof SECONDARY_LYRICS_MODEL,
	prompt: string,
	signal: AbortSignal
) {
	return runLyricsModel(
		env,
		model,
		{
			system: SONGWRITER_SYSTEM_PROMPT,
			messages: [{ role: 'user', content: prompt }],
			// 5000 covers adaptive thinking + dense non-Latin scripts (e.g. Gurmukhi/Hangul) without truncation.
			max_tokens: 5000,
			thinking: { type: 'adaptive' },
			output_config: {
				effort: 'low',
				format: {
					type: 'json_schema',
					schema: LYRICS_JSON_SCHEMA as unknown as Record<string, unknown>,
				},
			},
		},
		signal
	);
}

function runFable52(env: Env, prompt: string, signal: AbortSignal) {
	return runAnthropicLyrics(env, PRIMARY_LYRICS_MODEL, prompt, signal);
}

function runOpus55(env: Env, prompt: string, signal: AbortSignal) {
	return runAnthropicLyrics(env, SECONDARY_LYRICS_MODEL, prompt, signal);
}

function runDeepSeekFlash(env: Env, prompt: string, signal: AbortSignal) {
	return runLyricsModel(
		env,
		TERTIARY_LYRICS_MODEL,
		{
			messages: [
				{ role: 'system', content: SONGWRITER_SYSTEM_PROMPT },
				{ role: 'user', content: prompt },
			],
			max_completion_tokens: 2000,
			temperature: 0.75,
			reasoning_effort: 'none',
			chat_template_kwargs: { enable_thinking: false },
			response_format: { type: 'json_object' },
		},
		signal
	);
}

function runGlm53Fallback(env: Env, prompt: string, signal: AbortSignal) {
	return runLyricsModel(
		env,
		FALLBACK_LYRICS_MODEL,
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

interface CfLyricsRunner {
	model: LyricsModel;
	maxAttemptMs: number;
	run: (env: Env, prompt: string, signal: AbortSignal) => Promise<unknown>;
}

const DEFAULT_CF_LYRICS_RUNNERS: CfLyricsRunner[] = [
	{ model: PRIMARY_LYRICS_MODEL, maxAttemptMs: 32_000, run: runFable52 },
	{ model: SECONDARY_LYRICS_MODEL, maxAttemptMs: 24_000, run: runOpus55 },
	{ model: TERTIARY_LYRICS_MODEL, maxAttemptMs: 14_000, run: runDeepSeekFlash },
	{ model: FALLBACK_LYRICS_MODEL, maxAttemptMs: 12_000, run: runGlm53Fallback },
];

export function resolveLyricsRunners(env: Partial<Env>): CfLyricsRunner[] {
	const override = env.LYRICS_PRIMARY_MODEL?.trim();
	if (!override) {
		return DEFAULT_CF_LYRICS_RUNNERS;
	}
	const idx = DEFAULT_CF_LYRICS_RUNNERS.findIndex((r) => r.model === override);
	if (idx <= 0) {
		return DEFAULT_CF_LYRICS_RUNNERS;
	}
	return [
		DEFAULT_CF_LYRICS_RUNNERS[idx],
		...DEFAULT_CF_LYRICS_RUNNERS.slice(0, idx),
		...DEFAULT_CF_LYRICS_RUNNERS.slice(idx + 1),
	];
}

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
			/\bAiGatewayError:\s*(?:(?:2021|2052)\b|.*\bspend(?:ing)? limit\b.*\b(?:exceeded|reached)\b|.*\binsufficient unified billing\b)/i.test(
				detail
			) ||
			/\bAiError:\s*3036\b/.test(detail)
		) {
			return 'spend_limit';
		}
	}
	return 'binding_error';
}

export async function songWrite(
	env: Env,
	prompt: string,
	guardPrompt = prompt,
	smolId?: string
): Promise<SongWriteDetailedResult> {
	const runners = resolveLyricsRunners(env);
	const deadline = Date.now() + CF_LYRICS_BUDGET_MS;
	let attempts = 0;
	let skipThirdPartyBilling = false;
	const failures: CfLyricsModelFailure[] = [];

	for (const [index, runner] of runners.entries()) {
		if (skipThirdPartyBilling && !isNativeWorkersAiModel(runner.model)) {
			continue;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}

		// Preserve time for native @cf/ fallbacks so a slow third-party primary cannot starve the chain.
		const hasNativeAfter =
			!isNativeWorkersAiModel(runner.model) &&
			runners.slice(index + 1).some((r) => isNativeWorkersAiModel(r.model));
		const maxForThisAttempt = hasNativeAfter
			? Math.max(4_000, Math.min(runner.maxAttemptMs, remainingMs - RESERVE_NATIVE_FALLBACK_MS))
			: Math.min(runner.maxAttemptMs, remainingMs);
		const budgetMs = Math.min(remainingMs, maxForThisAttempt);

		attempts++;
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
			return {
				...result,
				model: runner.model,
				attempts,
				failures,
			};
		} catch (error) {
			const reason = classifyCfFailureReason(error);
			failures.push({ model: runner.model, reason });
			console.warn(
				JSON.stringify({
					event: 'cf_ai_lyrics_failed',
					...(smolId ? { smol_id: smolId } : {}),
					model: runner.model,
					reason,
				})
			);
			if (reason === 'spend_limit') {
				if (!isNativeWorkersAiModel(runner.model)) {
					// Unified Billing exhausted: skip remaining third-party models and fall through to native @cf/.
					skipThirdPartyBilling = true;
					continue;
				}
				break;
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw new CfLyricsAllModelsFailedError(attempts, failures);
}
