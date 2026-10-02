// Parameters for one song generation request.
export interface AiSongGeneratorGenerateParams {
    title: string;
    styles: string[]; // e.g., ["Synthwave", "Dreamy", "Electronic"]
    instrumental: boolean;
    lyrics?: string; // For lyrical mode
    description?: string; // For instrumental mode (maps to description)
    isPublic: boolean; // True if public, false if private
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
}

// Site default in the create page. The label in the UI is "V4". The API value is "v6".
const MUSIC_MODEL = 'v6';
const EASY_PROMPT_LIMIT = 3000;
const STYLE_LIMIT = 1000;
const ORIGIN = 'https://aisonggenerator.io';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface SubmitResponse {
    success?: boolean;
    message?: string;
    data?: {
        task_id?: string;
    };
}

interface MusicItem {
    music_id?: string;
    task_id?: string;
    status?: string;
    audio_url?: string | null;
    created_at?: string;
}

interface MusicListResponse {
    success?: boolean;
    message?: string;
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
    message?: string;
    data?: MusicItem;
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

function buildSubmitBody(params: AiSongGeneratorGenerateParams): Record<string, unknown> {
    const title = params.title?.trim() || undefined;

    if (params.instrumental) {
        const prompt = (params.description || '').trim().slice(0, EASY_PROMPT_LIMIT);
        if (!prompt) {
            throw new Error('Instrumental prompt is empty');
        }
        return {
            prompt,
            model: MUSIC_MODEL,
            customMode: false,
            instrumental: true,
            is_private: !params.isPublic,
            title,
        };
    }

    const prompt = (params.lyrics || '').trim();
    if (!prompt) {
        throw new Error('Lyrics prompt is empty');
    }
    const style = params.styles.map(style => style.trim()).filter(Boolean).join(', ').slice(0, STYLE_LIMIT);
    return {
        prompt,
        model: MUSIC_MODEL,
        customMode: true,
        instrumental: false,
        is_private: !params.isPublic,
        title,
        style: style || undefined,
    };
}

async function listMusic(env: Env, page: number): Promise<MusicListResponse> {
    const response = await fetch(`${ORIGIN}/api/music/list?scope=library&page=${page}`, {
        method: 'GET',
        headers: aisgAuthHeaders(env),
    });
    const json = await readJson<MusicListResponse>(response);
    if (!response.ok || !json?.success || !json.data?.items) {
        throw new Error(`Failed to list songs: ${response.status} ${json?.message || ''}`.trim());
    }
    return json;
}

async function findMusicIds(env: Env, taskId: string): Promise<string[]> {
    let found: MusicItem[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        const page = await listMusic(env, 1);
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
 * Generates a song using the aisonggenerator.io service.
 * @param params Parameters for song generation.
 * @param env Environment bindings.
 * @returns Music ids for the songs created by this task.
 */
export async function generateAiSongGeneratorSong(
    params: AiSongGeneratorGenerateParams,
    env: Env
): Promise<string[]> {
    const response = await fetch(`${ORIGIN}/api/music/submit`, {
        method: 'POST',
        headers: aisgAuthHeaders(env, true),
        body: JSON.stringify(buildSubmitBody(params)),
    });

    const json = await readJson<SubmitResponse>(response);
    if (!response.ok || !json?.success || !json.data?.task_id) {
        throw new Error(`Failed to post song to aisonggenerator.io: ${response.status} ${json?.message || ''}`.trim());
    }

    return findMusicIds(env, json.data.task_id);
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
        });

        if (!response.ok) {
            const json = await readJson<MusicDetailResponse>(response);
            console.error(`Failed to get status for musicId ${id}:`, response.status, json?.message || '');
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

        const audio = audioUrl(data.audio_url);
        return {
            music_id: data.music_id || id,
            status: mapStatus(data.status, audio !== null),
            audio,
            identify_id: data.task_id,
            service: 'aisonggenerator' as const,
        };
    });
}
