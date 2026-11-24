import { ProviderError, isTimeoutError } from './errors';

// Parameters for one song generation request.
export interface AiSongGeneratorGenerateParams {
	title: string;
	styles: string[]; // e.g., ["Synthwave", "Dreamy", "Electronic"]
	instrumental: boolean;
	lyrics?: string; // For lyrical mode
	description?: string; // For instrumental mode (maps to description)
	isPublic: boolean; // True if public, false if private
	vocalGender?: 'm' | 'f'; // Optional vocal gender hint (custom mode, 0 extra credits)
	negativeTags?: string; // Optional styles to exclude (max 200 chars, 0 extra credits)
	isOriginal?: boolean; // Optional declaration of original lyrics (custom mode, 0 extra credits)
	lyricsCompatibilityLevel?: 0 | 1 | 2 | 3; // Optional copyright false-positive shield (custom non-instrumental mode, 1-3)
	imageUrls?: string[]; // Optional reference image URLs for v6 easy mode (max 5 https URLs)
	workspaceId?: string; // Optional AISG workspace folder id (falls back to env.AISONGGENERATOR_WORKSPACE_ID)
}

// Receipt returned immediately after upstream task acceptance (POST /api/tasks).
export interface AiSongGeneratorTaskReceipt {
	task_id: string;
	workspace_id?: string;
}

// Discovery snapshot returned by read-only task lookup (GET /api/tasks/:id).
export interface AiSongGeneratorTaskDiscovery {
	task_id: string;
	music_ids: string[];
	next_page?: number;
}

export interface DiscoverTaskOptions {
	startPage?: number;
	maxPages?: number;
}

export interface FindMusicIdsOptions {
	maxAttempts?: number;
	delayMs?: number;
	maxPagesPerAttempt?: number;
	/**
	 * When true (unkeyed legacy POST /api/songs bridge for live deployed smol-workflow),
	 * preserves 6af87b5 non-retrying behavior if exactly 1 song is visible at loop exhaustion
	 * rather than throwing 504 into the live caller's 5-retry paid resubmit loop.
	 */
	allowSingletonOnExhaustion?: boolean;
}

// Song row returned to smol-workflow.
// status is numeric so the workflow poller can keep its existing checks:
// < 0 failed, < 4 still generating, >= 4 complete.
export interface AiSongGeneratorSong {
	music_id: string;
	status: number;
	audio: string | null;
	service: 'aisonggenerator';
	identify_id?: string; // Provider task id for this generation
	duration?: number; // Audio duration in seconds when reported
	provider?: string; // Upstream audio backend reported by AISG (e.g. "sun", "kie")
	credits_cost?: number;
	credits_refunded?: boolean;
	error_message?: string; // Fixed safe failure reason when status < 0
}

// Strictly non-PII credit & subscription snapshot from POST /api/user.
export interface AisgCredits {
	left_credits: number;
	paid_credits: number;
	used_credits: number;
	free_credits: number;
	plan_tier: string | null;
	has_active_sub: boolean;
}

// Site default in the create page. The label in the UI is "V4". The API value is "v6".
export const MUSIC_MODEL = 'v6';
export const EXPECTED_TRACKS_PER_TASK = 2;
export const DEFAULT_DISCOVERY_MAX_PAGES = 5;
export const TITLE_LIMIT = 80;
export const CUSTOM_LYRICS_LIMIT = 5000;
export const EASY_PROMPT_LIMIT = 3000;
export const STYLE_LIMIT = 1000;
export const NEGATIVE_TAGS_LIMIT = 200;
export const MAX_IMAGE_URLS = 5;
export const LOW_CREDITS_THRESHOLD = 500;
export const MIN_TASK_CREDITS = 4;
export const SESSION_EXPIRY_WARN_HOURS = 48;

const DEFAULT_DISCOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_DISCOVERY_DELAY_MS = 1000;
const SAFE_PROVIDER_SLUG_RE = /^[a-z0-9_-]{1,32}$/i;
const POLICY_PATTERN =
	/content\s*policy|policy\s*violat|moderat|nsfw|inappropriate|prohibited|copyright|flagged|sensitive\s*(content|word|lyrics|prompt)|artist\s*name|trademark|banned\s*word/i;
const CREDITS_PATTERN = /insufficient\s*credit|not\s+enough\s+credit|out\s+of\s+credit/i;
const ORIGIN = 'https://aisonggenerator.io';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface SubmitResponse {
	success?: boolean;
	message?: string;
	code?: string | number;
	data?: {
		task_id?: string;
	};
}

interface MusicItem {
	music_id?: string;
	task_id?: string;
	status?: string;
	audio_url?: string | null;
	processing_results?: {
		audio_source?: {
			url?: string | null;
			format?: string | null;
		} | null;
	} | null;
	duration?: number | null;
	created_at?: string;
	provider?: string;
	credits_cost?: number;
	credits_refunded?: boolean;
	error_message?: string | null;
}

interface MusicListResponse {
	success?: boolean;
	data?: {
		items?: MusicItem[];
		pagination?: {
			page?: number;
			totalPages?: number;
		};
	};
}

interface MusicDetailResponse {
	success?: unknown;
	data?: unknown;
}

interface UserProfileResponse {
	success?: boolean;
	data?: {
		left_credits?: unknown;
		paid_credits?: unknown;
		used_credits?: unknown;
		free_credits?: unknown;
		plan_tier?: unknown;
		has_active_sub?: unknown;
	};
}

interface AudioRecoveryResponse {
	success?: unknown;
}

function sessionCookie(env: Env): string {
	const token = env.AISONGGENERATOR_SESSION_TOKEN?.trim();
	if (!token) {
		throw new ProviderError('AISONGGENERATOR_SESSION_TOKEN is missing', {
			status: 401,
			provider: 'aisonggenerator',
			code: 'aisg_auth_error',
			retryable: false,
			outcome: 'rejected',
		});
	}
	return `__Secure-better-auth.session_token=${token}`;
}

export function aisgAuthHeaders(env: Env, json = false): HeadersInit {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		Cookie: sessionCookie(env),
		Origin: ORIGIN,
		Referer: `${ORIGIN}/create`,
		'User-Agent': USER_AGENT,
	};
	if (json) {
		headers['Content-Type'] = 'application/json';
	}
	return headers;
}

function mapStatus(status: string | undefined, hasAudio: boolean): number {
	if (status === 'failed' || status === 'canceled') {
		return -4;
	}
	if (status === 'completed' && hasAudio) {
		return 4;
	}
	if (status === 'completed' || status === 'processing') {
		return 2;
	}
	if (status === 'pending') {
		return 1;
	}
	return 0;
}

function audioUrl(value: string | null | undefined): string | null {
	if (typeof value === 'string' && value.trim() !== '') {
		return value;
	}
	return null;
}

function clampString(value: string | undefined | null, limit: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	return trimmed.slice(0, limit);
}

/**
 * Maps arbitrary upstream failure text to a closed set of fixed public messages
 * so raw upstream diagnostics / PII never reach callers while preserving
 * content-policy vs outage classification for smol-workflow.
 */
function classifySongErrorMessage(raw: string | null | undefined, status: string | undefined): string | undefined {
	if (status === 'canceled') {
		return 'Song generation was canceled';
	}
	if (typeof raw !== 'string' || !raw.trim()) {
		return undefined;
	}
	if (POLICY_PATTERN.test(raw)) {
		return 'Song generation rejected by content policy';
	}
	if (CREDITS_PATTERN.test(raw)) {
		return 'Song generation failed: insufficient credits';
	}
	if (/timeout|timed\s*out/i.test(raw)) {
		return 'Song generation timed out upstream';
	}
	if (/rate\s*limit|too\s+many\s+requests|busy|overload|temporarily\s+unavailable|service\s+unavailable/i.test(raw)) {
		return 'Song generation service temporarily unavailable';
	}
	return 'Song generation failed upstream';
}

function sanitizeImageUrls(urls: string[] | undefined): string[] {
	if (!Array.isArray(urls)) {
		return [];
	}
	const valid: string[] = [];
	for (const raw of urls) {
		if (typeof raw !== 'string') {
			continue;
		}
		const trimmed = raw.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === 'https:') {
				valid.push(parsed.toString());
			}
		} catch {
			// Skip invalid URLs
		}
		if (valid.length >= MAX_IMAGE_URLS) {
			break;
		}
	}
	return valid;
}

function normalizeCompatibilityLevel(value: unknown): 1 | 2 | 3 | undefined {
	if (value === 1 || value === 2 || value === 3) {
		return value;
	}
	return undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isInsufficientCredits(status: number, json: SubmitResponse | null): boolean {
	if (status === 402) {
		return true;
	}
	const message = typeof json?.message === 'string' ? json.message : '';
	const code = typeof json?.code === 'string' ? json.code : '';
	return CREDITS_PATTERN.test(`${message} ${code}`);
}

function isPolicyRejection(json: SubmitResponse | null): boolean {
	const message = typeof json?.message === 'string' ? json.message : '';
	const code = typeof json?.code === 'string' ? json.code : '';
	return POLICY_PATTERN.test(`${message} ${code}`);
}

function hasPositiveSubmitRejection(status: number, json: SubmitResponse | null): boolean {
	// Explicit 4xx client/auth/policy/credits/rate-limit rejections (excluding ambiguous 408/499 timeouts/aborts)
	if (status >= 400 && status < 500 && status !== 408 && status !== 499) {
		return true;
	}
	// Structured origin application rejection `{ success: false }` on 200, 500, or 503.
	// Gateway errors (502, 504, 52x) NEVER qualify as positive origin rejection even if their
	// message text mentions moderation or credit services.
	if (json?.success === false && (status === 200 || status === 500 || status === 503)) {
		return true;
	}
	return false;
}

async function readJsonSafe<T>(response: Response): Promise<{ ok: true; value: T | null } | { ok: false }> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { ok: false };
	}
	if (!text) {
		return { ok: true, value: null };
	}
	try {
		return { ok: true, value: JSON.parse(text) as T };
	} catch {
		return { ok: false };
	}
}

export function resolveWorkspaceId(
	params?: Pick<AiSongGeneratorGenerateParams, 'workspaceId'>,
	env?: Partial<Env>
): string | undefined {
	const candidate = params?.workspaceId?.trim() || env?.AISONGGENERATOR_WORKSPACE_ID?.trim();
	return candidate || undefined;
}

export function buildSubmitBody(
	params: AiSongGeneratorGenerateParams,
	env?: Partial<Env>
): Record<string, unknown> {
	const title = clampString(params.title, TITLE_LIMIT);
	const workspaceId = resolveWorkspaceId(params, env);

	if (params.instrumental) {
		const prompt = clampString(params.description, EASY_PROMPT_LIMIT);
		if (!prompt) {
			throw new ProviderError('Instrumental prompt is empty', {
				status: 400,
				provider: 'aisonggenerator',
				code: 'invalid_request',
				retryable: false,
				outcome: 'rejected',
			});
		}
		const imageUrls = sanitizeImageUrls(params.imageUrls);
		const body: Record<string, unknown> = {
			prompt,
			model: MUSIC_MODEL,
			customMode: false,
			instrumental: true,
			is_private: !params.isPublic,
		};
		if (imageUrls.length > 0) {
			body.imageUrls = imageUrls;
		}
		if (title) {
			body.title = title;
		}
		if (workspaceId) {
			body.workspace_id = workspaceId;
		}
		return body;
	}

	const prompt = clampString(params.lyrics, CUSTOM_LYRICS_LIMIT);
	if (!prompt) {
		throw new ProviderError('Lyrics prompt is empty', {
			status: 400,
			provider: 'aisonggenerator',
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
		});
	}
	if (!Array.isArray(params.styles)) {
		throw new ProviderError('Style tags must be an array of strings', {
			status: 400,
			provider: 'aisonggenerator',
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
		});
	}
	const style = clampString(
		params.styles
			.filter((item): item is string => typeof item === 'string')
			.map((item) => item.trim())
			.filter(Boolean)
			.join(', '),
		STYLE_LIMIT
	);
	const body: Record<string, unknown> = {
		prompt,
		model: MUSIC_MODEL,
		customMode: true,
		instrumental: false,
		is_private: !params.isPublic,
	};
	if (title) {
		body.title = title;
	}
	if (style) {
		body.style = style;
	}
	if (params.vocalGender === 'm' || params.vocalGender === 'f') {
		body.vocalGender = params.vocalGender;
	}
	const negativeTags = clampString(params.negativeTags, NEGATIVE_TAGS_LIMIT);
	if (negativeTags) {
		body.negativeTags = negativeTags;
	}
	if (typeof params.isOriginal === 'boolean') {
		body.is_original = params.isOriginal;
	}
	const compatibilityLevel = normalizeCompatibilityLevel(params.lyricsCompatibilityLevel);
	if (compatibilityLevel) {
		body.lyrics_compatibility_level = compatibilityLevel;
	}
	if (workspaceId) {
		body.workspace_id = workspaceId;
	}
	return body;
}

/**
 * Classifies paid POST /api/music/submit failures.
 * Positive evidence of rejection MUST be confirmed BEFORE inspecting message/code keywords
 * so ambiguous gateway errors (502, 504, bare 500/503, 408/499, 52x) can never be
 * misclassified into 402/422 or authorize a retry/paid fallback.
 */
function classifySubmitFailure(status: number, json: SubmitResponse | null): ProviderError {
	if (!hasPositiveSubmitRejection(status, json)) {
		return new ProviderError(`AISG song submission outcome unknown after dispatch (HTTP ${status})`, {
			status: status === 504 ? 504 : status === 503 ? 503 : 502,
			provider: 'aisonggenerator',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
			upstreamStatus: status,
		});
	}

	if (isInsufficientCredits(status, json)) {
		return new ProviderError(`AISG song submission failed: insufficient credits (HTTP ${status})`, {
			status: 402,
			provider: 'aisonggenerator',
			code: 'aisg_insufficient_credits',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: status,
		});
	}
	if (isPolicyRejection(json)) {
		return new ProviderError(`AISG song submission rejected by content policy (HTTP ${status})`, {
			status: 422,
			provider: 'aisonggenerator',
			code: 'aisg_policy_rejected',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: status,
		});
	}
	if (status === 401) {
		return new ProviderError('AISG song submission failed: unauthorized (HTTP 401)', {
			status: 401,
			provider: 'aisonggenerator',
			code: 'aisg_auth_error',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: 401,
		});
	}
	if (status === 403) {
		return new ProviderError('AISG song submission failed (HTTP 403)', {
			status: 403,
			provider: 'aisonggenerator',
			code: 'aisg_forbidden',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: 403,
		});
	}
	if (status === 429) {
		return new ProviderError('AISG song submission rate limited (HTTP 429)', {
			status: 429,
			provider: 'aisonggenerator',
			code: 'aisg_rate_limited',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: 429,
		});
	}
	if (status === 400 || status === 422) {
		return new ProviderError(`AISG song submission rejected invalid input (HTTP ${status})`, {
			status,
			provider: 'aisonggenerator',
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: status,
		});
	}
	if (status >= 400 && status < 500) {
		return new ProviderError(`AISG song submission failed (HTTP ${status})`, {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: status,
		});
	}
	return new ProviderError(`AISG song submission failed (HTTP ${status})`, {
		status: status === 503 ? 503 : 502,
		provider: 'aisonggenerator',
		code: 'aisg_upstream_error',
		retryable: true,
		outcome: 'rejected',
		upstreamStatus: status,
	});
}

function classifyReadStatusFailure(context: string, status: number): ProviderError {
	if (status === 401) {
		return new ProviderError(`${context} unauthorized (HTTP 401)`, {
			status: 401,
			provider: 'aisonggenerator',
			code: 'aisg_auth_error',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: 401,
		});
	}
	if (status === 403) {
		return new ProviderError(`${context} forbidden (HTTP 403)`, {
			status: 403,
			provider: 'aisonggenerator',
			code: 'aisg_forbidden',
			retryable: false,
			outcome: 'rejected',
			upstreamStatus: 403,
		});
	}
	if (status === 429) {
		return new ProviderError(`${context} rate limited (HTTP 429)`, {
			status: 429,
			provider: 'aisonggenerator',
			code: 'aisg_rate_limited',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: 429,
		});
	}
	if (status === 504) {
		return new ProviderError(`${context} timed out upstream (HTTP 504)`, {
			status: 504,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: 504,
		});
	}
	return new ProviderError(`${context} failed (HTTP ${status})`, {
		status: status === 503 ? 503 : 502,
		provider: 'aisonggenerator',
		code: 'aisg_upstream_error',
		retryable: true,
		outcome: 'rejected',
		upstreamStatus: status,
	});
}

async function listMusic(env: Env, page: number, workspaceId?: string): Promise<MusicListResponse> {
	const headers = aisgAuthHeaders(env);
	const query = new URLSearchParams({
		scope: 'library',
		page: String(page),
	});
	if (workspaceId) {
		query.set('workspace_id', workspaceId);
	}

	let response: Response;
	try {
		response = await fetch(`${ORIGIN}/api/music/list?${query.toString()}`, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		throw new ProviderError('AISG song list request failed (network or timeout)', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
		});
	}

	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw classifyReadStatusFailure('AISG song list request', response.status);
	}

	const parsed = await readJsonSafe<MusicListResponse>(response);
	if (!parsed.ok || !parsed.value?.success || !Array.isArray(parsed.value.data?.items)) {
		throw new ProviderError(`AISG song list request failed (HTTP ${response.status})`, {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}
	return parsed.value;
}

/**
 * Submits a paid AISG v6 generation task and returns the upstream task_id immediately
 * after acceptance so callers can checkpoint task_id before read-only discovery.
 */
export async function submitAiSongGeneratorTask(
	params: AiSongGeneratorGenerateParams,
	env: Env
): Promise<AiSongGeneratorTaskReceipt> {
	const workspaceId = resolveWorkspaceId(params, env);
	const body = buildSubmitBody(params, env);
	const headers = aisgAuthHeaders(env, true);

	let response: Response;
	try {
		response = await fetch(`${ORIGIN}/api/music/submit`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		});
	} catch (error) {
		throw new ProviderError('AISG song submission outcome unknown after dispatch', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'aisonggenerator',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
		});
	}

	const parsed = await readJsonSafe<SubmitResponse>(response);

	if (response.ok) {
		if (!parsed.ok) {
			throw new ProviderError('AISG song submission response lost after dispatch', {
				status: 502,
				provider: 'aisonggenerator',
				code: 'aisg_dispatch_unknown',
				retryable: false,
				outcome: 'unknown',
				upstreamStatus: response.status,
			});
		}
		const json = parsed.value;
		const taskId = typeof json?.data?.task_id === 'string' ? json.data.task_id.trim() : '';
		if (json?.success && taskId) {
			return workspaceId ? { task_id: taskId, workspace_id: workspaceId } : { task_id: taskId };
		}
		if (json && json.success === false) {
			throw classifySubmitFailure(response.status, json);
		}
		throw new ProviderError('AISG song submission returned unreadable acceptance response', {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
			upstreamStatus: response.status,
		});
	}

	throw classifySubmitFailure(response.status, parsed.ok ? parsed.value : null);
}

/**
 * Read-only bounded discovery of music IDs belonging to a previously accepted task_id.
 * Scans up to `maxPages` (default 5) starting from `startPage` (default 1), exposes
 * `next_page` when more library pages exist, enforces the v6 0-2 distinct ID contract,
 * and rejects excess matches (>2 distinct IDs) explicitly.
 */
export async function discoverAiSongGeneratorTaskMusicIds(
	taskId: string,
	env: Env,
	workspaceId?: string,
	options?: DiscoverTaskOptions
): Promise<AiSongGeneratorTaskDiscovery> {
	const trimmedTaskId = taskId.trim();
	if (!trimmedTaskId) {
		throw new ProviderError('Task id is required', {
			status: 400,
			provider: 'aisonggenerator',
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
		});
	}

	const startPage = Math.max(1, Math.floor(options?.startPage ?? 1));
	const maxPages = Math.max(1, Math.min(20, Math.floor(options?.maxPages ?? DEFAULT_DISCOVERY_MAX_PAGES)));
	const effectiveWorkspaceId = resolveWorkspaceId(workspaceId ? { workspaceId } : undefined, env);
	const foundIds = new Set<string>();

	let totalPages = startPage;
	let lastCheckedPage = startPage - 1;

	for (let offset = 0; offset < maxPages; offset++) {
		const pageNum = startPage + offset;
		if (offset > 0 && pageNum > totalPages) {
			break;
		}

		const page = await listMusic(env, pageNum, effectiveWorkspaceId);
		lastCheckedPage = pageNum;
		const reportedTotal = page.data?.pagination?.totalPages;
		if (typeof reportedTotal === 'number' && Number.isFinite(reportedTotal) && reportedTotal >= 1) {
			totalPages = Math.floor(reportedTotal);
		} else {
			totalPages = Math.max(totalPages, pageNum);
		}

		for (const item of page.data?.items ?? []) {
			if (item.task_id === trimmedTaskId && typeof item.music_id === 'string' && item.music_id.trim()) {
				foundIds.add(item.music_id.trim());
			}
		}

		if (foundIds.size > EXPECTED_TRACKS_PER_TASK) {
			throw new ProviderError(
				`AISG task discovery returned more than ${EXPECTED_TRACKS_PER_TASK} distinct song records`,
				{
					status: 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: false,
					outcome: 'unknown',
					taskId: trimmedTaskId,
				}
			);
		}

		if (foundIds.size === EXPECTED_TRACKS_PER_TASK) {
			break;
		}
	}

	const musicIds = Array.from(foundIds).sort((a, b) => a.localeCompare(b));
	const result: AiSongGeneratorTaskDiscovery = {
		task_id: trimmedTaskId,
		music_ids: musicIds,
	};
	if (musicIds.length < EXPECTED_TRACKS_PER_TASK && lastCheckedPage < totalPages) {
		result.next_page = lastCheckedPage + 1;
	}
	return result;
}

function mergeDiscoveredIds(target: Set<string>, incoming: string[], taskId: string): void {
	for (const id of incoming) {
		target.add(id);
	}
	if (target.size > EXPECTED_TRACKS_PER_TASK) {
		throw new ProviderError(
			`AISG task discovery returned more than ${EXPECTED_TRACKS_PER_TASK} distinct song records`,
			{
				status: 502,
				provider: 'aisonggenerator',
				code: 'aisg_upstream_error',
				retryable: false,
				outcome: 'unknown',
				taskId,
			}
		);
	}
}

/**
 * Bounded discovery loop for legacy POST /api/songs.
 * Always rechecks page 1 (newest library page) on every poll attempt while maintaining
 * an independent cursor across older pages so newly indexed page-1 tasks are never missed
 * on deep multi-page libraries.
 */
export async function findMusicIds(
	env: Env,
	taskId: string,
	workspaceId?: string,
	options?: FindMusicIdsOptions
): Promise<string[]> {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_DISCOVERY_MAX_ATTEMPTS);
	const delayMs = Math.max(0, options?.delayMs ?? DEFAULT_DISCOVERY_DELAY_MS);
	const maxPagesPerAttempt = Math.max(1, options?.maxPagesPerAttempt ?? DEFAULT_DISCOVERY_MAX_PAGES);
	const deeperSliceSize = Math.max(0, maxPagesPerAttempt - 1);
	const allowSingleton = Boolean(options?.allowSingletonOnExhaustion);
	const collected = new Set<string>();
	let olderCursorPage = 2;
	let lastTransientError: ProviderError | null = null;

	const wrapPostSubmitError = (error: unknown): ProviderError => {
		if (error instanceof ProviderError) {
			return new ProviderError(error.message, {
				status: error.status,
				provider: error.provider,
				code: error.code,
				retryable: false,
				outcome: 'unknown',
				upstreamStatus: error.upstreamStatus,
				taskId,
			});
		}
		return new ProviderError('AISG song discovery failed after task acceptance', {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: false,
			outcome: 'unknown',
			taskId,
		});
	};

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0 && delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}

		let head: AiSongGeneratorTaskDiscovery;
		try {
			// Always check page 1 first so newly created pairs appearing at the head of the library
			// are discovered immediately even when totalPages is large.
			head = await discoverAiSongGeneratorTaskMusicIds(taskId, env, workspaceId, {
				startPage: 1,
				maxPages: 1,
			});
			lastTransientError = null;
			mergeDiscoveredIds(collected, head.music_ids, taskId);
			if (collected.size === EXPECTED_TRACKS_PER_TASK) {
				return Array.from(collected).sort((a, b) => a.localeCompare(b));
			}
		} catch (error) {
			if (error instanceof ProviderError && error.retryable) {
				lastTransientError = error;
				continue;
			}
			throw wrapPostSubmitError(error);
		}

		// Advance independent cursor over older pages when more pages exist beyond page 1.
		// A transient failure on an optional older page stays inside the bounded loop so
		// page 1 still gets subsequent attempts instead of aborting into a caller retry.
		if (deeperSliceSize > 0 && head.next_page !== undefined) {
			try {
				const deeper = await discoverAiSongGeneratorTaskMusicIds(taskId, env, workspaceId, {
					startPage: olderCursorPage,
					maxPages: deeperSliceSize,
				});
				mergeDiscoveredIds(collected, deeper.music_ids, taskId);
				if (collected.size === EXPECTED_TRACKS_PER_TASK) {
					return Array.from(collected).sort((a, b) => a.localeCompare(b));
				}
				olderCursorPage = deeper.next_page ?? 2;
			} catch (error) {
				if (error instanceof ProviderError && error.retryable) {
					console.warn(
						JSON.stringify({
							event: 'aisg_discovery_deeper_page_skipped',
							page: olderCursorPage,
							code: error.code,
							status: error.status,
							upstream_status: error.upstreamStatus,
						})
					);
					continue;
				}
				throw wrapPostSubmitError(error);
			}
		}
	}

	if (allowSingleton && collected.size === 1) {
		return Array.from(collected);
	}

	if (collected.size === 0 && lastTransientError) {
		throw wrapPostSubmitError(lastTransientError);
	}

	const message =
		collected.size === 0
			? 'Song records were not found for the new task'
			: `Only ${collected.size} of ${EXPECTED_TRACKS_PER_TASK} song records were found for the new task`;

	throw new ProviderError(message, {
		status: 504,
		provider: 'aisonggenerator',
		code: 'aisg_task_not_found',
		retryable: false,
		outcome: 'unknown',
		taskId,
	});
}

/**
 * Fetches the current AISG credit balance and subscription status via bodyless POST /api/user (0 credits).
 * Extracts strictly non-PII fields.
 */
export async function getAisgCredits(env: Env): Promise<AisgCredits> {
	const headers = aisgAuthHeaders(env);
	let response: Response;
	try {
		response = await fetch(`${ORIGIN}/api/user`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		throw new ProviderError('AISG credits check failed (network or timeout)', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
		});
	}

	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw classifyReadStatusFailure('AISG credits check', response.status);
	}

	const parsed = await readJsonSafe<UserProfileResponse>(response);
	if (!parsed.ok) {
		throw new ProviderError('AISG credits check returned unreadable response', {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}
	const data = parsed.value?.data;
	if (!data || typeof data.left_credits !== 'number' || !Number.isFinite(data.left_credits)) {
		throw new ProviderError('AISG credits check returned invalid credit payload', {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}

	return {
		left_credits: data.left_credits,
		paid_credits: finiteNumber(data.paid_credits),
		used_credits: finiteNumber(data.used_credits),
		free_credits: finiteNumber(data.free_credits),
		plan_tier: typeof data.plan_tier === 'string' && data.plan_tier.trim() ? data.plan_tier.trim() : null,
		has_active_sub: Boolean(data.has_active_sub),
	};
}

/**
 * Requests free (0-credit) upstream audio recovery for a stalled or missing-audio AISG song.
 */
export async function recoverAisgAudio(musicId: string, env: Env): Promise<boolean> {
	const trimmedId = musicId.trim();
	if (!trimmedId) {
		throw new ProviderError('Music id is required for audio recovery', {
			status: 400,
			provider: 'aisonggenerator',
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
		});
	}

	const headers = aisgAuthHeaders(env);
	let response: Response;
	try {
		response = await fetch(`${ORIGIN}/api/music/${encodeURIComponent(trimmedId)}/audio/recovery`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		throw new ProviderError('AISG audio recovery failed (network or timeout)', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
		});
	}

	if (!response.ok) {
		throw classifyReadStatusFailure('AISG audio recovery', response.status);
	}

	const parsed = await readJsonSafe<AudioRecoveryResponse>(response);
	if (!parsed.ok || parsed.value?.success !== true) {
		throw new ProviderError(`AISG audio recovery failed (HTTP ${response.status})`, {
			status: 502,
			provider: 'aisonggenerator',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}
	return true;
}

/**
 * Retrieves song results for music ids.
 * Reserves the legacy pending row (status: 0) strictly for explicit missing results
 * (HTTP 404 or `{ success: true, data: null }`). Empty 200 bodies, `{ success: false }`
 * application failures, unrecognized envelopes, and 5xx outages surface as structured read errors.
 */
export async function getAiSongGeneratorSongResults(
	musicIds: string[],
	env: Env
): Promise<AiSongGeneratorSong[]> {
	if (!musicIds || musicIds.length === 0) {
		return [];
	}

	const headers = aisgAuthHeaders(env);

	const responses = await Promise.all(
		musicIds.map(async (id) => {
			let response: Response;
			try {
				response = await fetch(`${ORIGIN}/api/music/${encodeURIComponent(id)}`, {
					method: 'GET',
					headers,
					signal: AbortSignal.timeout(10000),
				});
			} catch (error) {
				throw new ProviderError('AISG song status request failed (network or timeout)', {
					status: isTimeoutError(error) ? 504 : 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: true,
					outcome: 'rejected',
				});
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				if (response.status === 404) {
					return null;
				}
				throw classifyReadStatusFailure('AISG song status request', response.status);
			}

			const parsed = await readJsonSafe<MusicDetailResponse>(response);
			if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
				throw new ProviderError('AISG song status request returned empty or unreadable response', {
					status: 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: true,
					outcome: 'rejected',
					upstreamStatus: response.status,
				});
			}

			if (parsed.value.success !== true) {
				throw new ProviderError('AISG song status request failed upstream', {
					status: 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: true,
					outcome: 'rejected',
					upstreamStatus: response.status,
				});
			}

			if (parsed.value.data === null) {
				return null;
			}

			if (typeof parsed.value.data !== 'object' || Array.isArray(parsed.value.data)) {
				throw new ProviderError('AISG song status request returned invalid song payload', {
					status: 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: true,
					outcome: 'rejected',
					upstreamStatus: response.status,
				});
			}

			const item = parsed.value.data as MusicItem;
			if (typeof item.music_id !== 'string' || !item.music_id.trim()) {
				throw new ProviderError('AISG song status request returned song payload without music_id', {
					status: 502,
					provider: 'aisonggenerator',
					code: 'aisg_upstream_error',
					retryable: true,
					outcome: 'rejected',
					upstreamStatus: response.status,
				});
			}

			return item;
		})
	);

	return musicIds.map((id, index) => {
		const data = responses[index];
		if (!data) {
			return {
				music_id: id,
				status: 0,
				audio: null,
				service: 'aisonggenerator' as const,
			};
		}

		const audio = audioUrl(data.audio_url) ?? audioUrl(data.processing_results?.audio_source?.url);
		const status = mapStatus(data.status, audio !== null);
		const row: AiSongGeneratorSong = {
			music_id: data.music_id || id,
			status,
			audio,
			identify_id: data.task_id,
			service: 'aisonggenerator' as const,
		};

		if (typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0) {
			row.duration = data.duration;
		}
		if (typeof data.provider === 'string' && SAFE_PROVIDER_SLUG_RE.test(data.provider.trim())) {
			row.provider = data.provider.trim();
		}
		if (typeof data.credits_cost === 'number' && Number.isFinite(data.credits_cost)) {
			row.credits_cost = data.credits_cost;
		}
		if (typeof data.credits_refunded === 'boolean') {
			row.credits_refunded = data.credits_refunded;
		}
		if (status < 0) {
			const errorMessage = classifySongErrorMessage(data.error_message, data.status);
			if (errorMessage) {
				row.error_message = errorMessage;
			}
		}

		return row;
	});
}
