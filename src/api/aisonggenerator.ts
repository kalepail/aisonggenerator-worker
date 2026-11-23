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
    error_message?: string; // Clamped upstream failure reason when status < 0
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
export const TITLE_LIMIT = 80;
export const CUSTOM_LYRICS_LIMIT = 5000;
export const EASY_PROMPT_LIMIT = 3000;
export const STYLE_LIMIT = 1000;
export const NEGATIVE_TAGS_LIMIT = 200;
export const MAX_IMAGE_URLS = 5;
export const LOW_CREDITS_THRESHOLD = 500;
export const MIN_TASK_CREDITS = 4;
export const SESSION_EXPIRY_WARN_HOURS = 48;

const ERROR_MESSAGE_LIMIT = 200;
const ORIGIN = 'https://aisonggenerator.io';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
    success?: boolean;
    data?: MusicItem;
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

interface StyleOptimizeResponse {
    result?: unknown;
    error?: unknown;
}

interface AudioRecoveryResponse {
    success?: boolean;
}

function sessionCookie(env: Env): string {
    const token = env.AISONGGENERATOR_SESSION_TOKEN?.trim();
    if (!token) {
        throw new Error('AISONGGENERATOR_SESSION_TOKEN is missing');
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

function sanitizeErrorMessage(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return undefined;
    }
    return normalized.slice(0, ERROR_MESSAGE_LIMIT);
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
    return /insufficient\s*credit|not\s+enough\s+credit|out\s+of\s+credit/i.test(`${message} ${code}`);
}

async function readJson<T>(response: Response): Promise<T | null> {
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
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
            throw new Error('Instrumental prompt is empty');
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
        throw new Error('Lyrics prompt is empty');
    }
    const style = clampString(
        params.styles.map(item => item.trim()).filter(Boolean).join(', '),
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

async function listMusic(env: Env, page: number, workspaceId?: string): Promise<MusicListResponse> {
    const query = new URLSearchParams({
        scope: 'library',
        page: String(page),
    });
    if (workspaceId) {
        query.set('workspace_id', workspaceId);
    }

    const response = await fetch(`${ORIGIN}/api/music/list?${query.toString()}`, {
        method: 'GET',
        headers: aisgAuthHeaders(env),
        signal: AbortSignal.timeout(10000),
    });
    const json = await readJson<MusicListResponse>(response);
    if (!response.ok || !json?.success || !json.data?.items) {
        throw new Error(`AISG song list request failed (HTTP ${response.status})`);
    }
    return json;
}

async function findMusicIds(env: Env, taskId: string, workspaceId?: string): Promise<string[]> {
    let found: MusicItem[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        const page = await listMusic(env, 1, workspaceId);
        found = (page.data?.items || []).filter(item => item.task_id === taskId && item.music_id);
        if (found.length >= 2) {
            break;
        }
        if (found.length === 1 && attempt >= 2) {
            break;
        }
    }

    if (found.length === 0) {
        throw new Error('Song records were not found for the new task');
    }

    return found
        .map(item => item.music_id as string)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Fetches the current AISG credit balance and subscription status via bodyless POST /api/user (0 credits).
 * Extracts strictly non-PII fields.
 */
export async function getAisgCredits(env: Env): Promise<AisgCredits> {
    const response = await fetch(`${ORIGIN}/api/user`, {
        method: 'POST',
        headers: aisgAuthHeaders(env),
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        throw new Error(`AISG credits check failed (HTTP ${response.status})`);
    }

    const json = await readJson<UserProfileResponse>(response);
    const data = json?.data;
    if (!data || typeof data.left_credits !== 'number' || !Number.isFinite(data.left_credits)) {
        throw new Error('AISG credits check returned invalid credit payload');
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
 * Enhances a style prompt using AISG's free (0-credit) style optimizer.
 */
export async function optimizeAisgStyle(content: string, env: Env): Promise<string> {
    const input = clampString(content, STYLE_LIMIT);
    if (!input) {
        throw new Error('Style content is empty');
    }

    const response = await fetch(`${ORIGIN}/api/music/style/optimize`, {
        method: 'POST',
        headers: aisgAuthHeaders(env, true),
        body: JSON.stringify({ content: input }),
        signal: AbortSignal.timeout(10000),
    });

    const json = await readJson<StyleOptimizeResponse>(response);
    if (!response.ok) {
        throw new Error(`AISG style optimize failed (HTTP ${response.status})`);
    }

    const optimized = typeof json?.result === 'string' ? clampString(json.result, STYLE_LIMIT) : undefined;
    if (!optimized) {
        throw new Error('AISG style optimize returned empty result');
    }
    return optimized;
}

/**
 * Requests free (0-credit) upstream audio recovery for a stalled or missing-audio AISG song.
 */
export async function recoverAisgAudio(musicId: string, env: Env): Promise<boolean> {
    const trimmedId = musicId.trim();
    if (!trimmedId) {
        throw new Error('Music id is required for audio recovery');
    }

    const response = await fetch(`${ORIGIN}/api/music/${encodeURIComponent(trimmedId)}/audio/recovery`, {
        method: 'POST',
        headers: aisgAuthHeaders(env),
        signal: AbortSignal.timeout(10000),
    });

    const json = await readJson<AudioRecoveryResponse>(response);
    if (!response.ok || json?.success === false) {
        throw new Error(`AISG audio recovery failed (HTTP ${response.status})`);
    }
    return true;
}

/**
 * Generates a song using the aisonggenerator.io service.
 * @param params Parameters for song generation.
 * @param env Environment bindings.
 * @returns Music ids for the songs created by this task.
 */
export async function generateAiSongGeneratorSong(
    params: AiSongGeneratorGenerateParams,
    env: Env
): Promise<string[]> {
    const workspaceId = resolveWorkspaceId(params, env);
    const response = await fetch(`${ORIGIN}/api/music/submit`, {
        method: 'POST',
        headers: aisgAuthHeaders(env, true),
        body: JSON.stringify(buildSubmitBody(params, env)),
        signal: AbortSignal.timeout(15000),
    });

    const json = await readJson<SubmitResponse>(response);
    if (!response.ok || !json?.success || !json.data?.task_id) {
        if (isInsufficientCredits(response.status, json)) {
            throw new Error(`AISG song submission failed: insufficient credits (HTTP ${response.status})`);
        }
        throw new Error(`AISG song submission failed (HTTP ${response.status})`);
    }

    return findMusicIds(env, json.data.task_id, workspaceId);
}

/**
 * Retrieves song results for music ids.
 * @param musicIds Music ids returned by generateAiSongGeneratorSong.
 * @param env Environment bindings.
 * @returns Song rows in the same order as musicIds.
 */
export async function getAiSongGeneratorSongResults(
    musicIds: string[],
    env: Env,
    _userIdArg?: string
): Promise<AiSongGeneratorSong[]> {
    if (!musicIds || musicIds.length === 0) {
        return [];
    }

    const responses = await Promise.all(musicIds.map(async (id) => {
        const response = await fetch(`${ORIGIN}/api/music/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: aisgAuthHeaders(env),
            signal: AbortSignal.timeout(10000),
        });

        if (response.status === 401 || response.status === 403) {
            throw new Error(`AISG song status request was unauthorized (HTTP ${response.status})`);
        }
        if (!response.ok) {
            console.warn(`AISG song status request failed (HTTP ${response.status})`);
            return null;
        }

        const json = await readJson<MusicDetailResponse>(response);
        if (json?.success && json.data?.music_id) {
            return json.data;
        }
        return null;
    }));

    return musicIds.map((id, index) => {
        const data = responses[index];
        if (!data) {
            return {
                music_id: id,
                status: 0,
                audio: null,
                identify_id: id,
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
        if (typeof data.provider === 'string' && data.provider.trim()) {
            row.provider = data.provider.trim();
        }
        if (typeof data.credits_cost === 'number' && Number.isFinite(data.credits_cost)) {
            row.credits_cost = data.credits_cost;
        }
        if (typeof data.credits_refunded === 'boolean') {
            row.credits_refunded = data.credits_refunded;
        }
        if (status < 0) {
            const errorMessage = sanitizeErrorMessage(data.error_message);
            if (errorMessage) {
                row.error_message = errorMessage;
            }
        }

        return row;
    });
}
