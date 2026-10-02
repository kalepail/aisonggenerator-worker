// AI Singing session and song client. The product also answers on diffrhythm.com.
// The signed-in account for smol is https://aisinging.ai.
// Auth is __Secure-next-auth.session-token. There is no separate refresh token.

const ORIGIN = "https://aisinging.ai";
const API = `${ORIGIN}/api`;
const SESSION_URL = `${API}/auth/session`;
const ACCOUNT_URL = `${API}/user/info`;
const TASKS_URL = `${API}/app/tasks`;
const CLIENT_VERSION = "v0.2.7";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SESSION_COOKIE = "__Secure-next-auth.session-token";

const TEXT_TO_MUSIC = "text-to-music";
const LYRICS_TO_MUSIC = "lyrics-to-music";

export interface DiffRhythmGenerateParams {
    title: string;
    tags: string;
    isPublic?: boolean;
    instrumental: boolean;
    lyrics?: string;
    description?: string;
    userId?: string;
    fingerprint?: string;
}

export interface TransformedSong {
    music_id: string;
    status: number;
    audio: string | null;
    service: "diffrhythm";
}

interface TaskOutput {
    status?: number;
    url?: string | null;
    index?: number;
}

interface TaskItem {
    _id?: string;
    id?: string;
    status?: number;
    outputs?: TaskOutput[];
}

interface TaskListResponse {
    status?: number;
    error?: string;
    data?: {
        items?: TaskItem[];
        taskId?: string;
    };
}

export function normalizeDiffrhythmCookie(value: string | undefined): string {
    const trimmed = value?.trim() || "";
    if (!trimmed) {
        return "";
    }
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
        return trimmed;
    }
    return `${SESSION_COOKIE}=${trimmed}`;
}

function cookieHeaders(cookie: string, json = false): Headers {
    const headers = new Headers({
        Accept: "application/json",
        Cookie: cookie,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/text-to-song`,
        "User-Agent": USER_AGENT,
        "x-client-version": CLIENT_VERSION,
    });
    if (json) {
        headers.set("Content-Type", "application/json");
    }
    return headers;
}

async function diffrhythmFetch(url: string, cookie: string, init: RequestInit = {}): Promise<Response> {
    const headers = cookieHeaders(cookie, init.body != null);
    const extra = new Headers(init.headers);
    extra.forEach((value, key) => headers.set(key, value));
    const response = await fetch(url, { ...init, headers });
    if (response.status !== 426) {
        return response;
    }
    const nextVersion = response.headers.get("x-app-version");
    await response.arrayBuffer();
    if (!nextVersion || nextVersion === CLIENT_VERSION) {
        return response;
    }
    headers.set("x-client-version", nextVersion);
    return fetch(url, { ...init, headers });
}

function sessionCookieFromResponse(response: Response): string {
    const rows = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("Set-Cookie") || ""];
    for (const row of rows) {
        const match = row.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
        if (match?.[1]) {
            return `${SESSION_COOKIE}=${match[1]}`;
        }
    }
    return "";
}

export async function refreshDiffrhythmCookie(candidates: string[]): Promise<string> {
    const seen = new Set<string>();
    let lastStatus = 0;
    for (const candidate of candidates) {
        const cookie = normalizeDiffrhythmCookie(candidate);
        if (!cookie || seen.has(cookie)) {
            continue;
        }
        seen.add(cookie);
        const response = await diffrhythmFetch(SESSION_URL, cookie);
        const json = await response.json().catch(() => null) as { user?: { id?: string } } | null;
        lastStatus = response.status;
        if (!response.ok || !json?.user?.id) {
            continue;
        }
        // A diffrhythm.com session can decode on aisinging.ai and still be unauthorized.
        const account = await diffrhythmFetch(ACCOUNT_URL, cookie);
        const accountJson = await account.json().catch(() => null) as { data?: { credits?: number } } | null;
        if (account.ok && accountJson?.data && "credits" in accountJson.data) {
            return sessionCookieFromResponse(response) || cookie;
        }
        lastStatus = account.status;
    }
    throw new Error(`DiffRhythm session has no user (${lastStatus})`);
}

function taskBody(params: DiffRhythmGenerateParams): { featureKey: string; input: Record<string, unknown> } {
    const isPublic = params.isPublic === undefined ? false : params.isPublic;
    if (params.instrumental) {
        return {
            featureKey: TEXT_TO_MUSIC,
            input: {
                description: params.description || params.lyrics || "",
                instrumental: true,
                isPublic,
            },
        };
    }
    return {
        featureKey: LYRICS_TO_MUSIC,
        input: {
            lyrics: params.lyrics || "",
            styleOfMusic: params.tags || "",
            title: params.title || "",
            instrumental: false,
            isPublic,
        },
    };
}

async function createTask(cookie: string, params: DiffRhythmGenerateParams): Promise<string> {
    const response = await diffrhythmFetch(TASKS_URL, cookie, {
        method: "POST",
        body: JSON.stringify(taskBody(params)),
    });
    const result = await response.json().catch(() => null) as TaskListResponse | null;
    const taskId = result?.data?.taskId;
    if (!response.ok || !taskId) {
        const code = result?.error || response.statusText || "request failed";
        throw new Error(`Failed to generate song with Diffrhythm: ${response.status} ${code}`);
    }
    return taskId;
}

export async function generateDiffRhythmSong(params: DiffRhythmGenerateParams, env: Env): Promise<string[]> {
    const doid = env.DURABLE_OBJECT.idFromName("v0.0.0");
    const stub = env.DURABLE_OBJECT.get(doid);
    const sessionToken = await stub.getDiffrhythmSession(true);
    if (typeof sessionToken !== "string" || !sessionToken) {
        throw new Error("DiffRhythm session is missing");
    }

    // smol.xyz stores two song ids for every generation.
    const first = await createTask(sessionToken, params);
    const second = await createTask(sessionToken, params);
    return [first, second];
}

function mapTask(id: string, task: TaskItem | undefined): TransformedSong {
    if (!task) {
        return { music_id: id, status: 0, audio: null, service: "diffrhythm" };
    }
    const outputs = Array.isArray(task.outputs) ? task.outputs : [];
    const withAudio = outputs.find((output) => output?.url);
    if (withAudio?.url) {
        return { music_id: id, status: 4, audio: withAudio.url, service: "diffrhythm" };
    }
    const failed = task.status === 2 || outputs.some((output) => output?.status === 2);
    if (failed) {
        return { music_id: id, status: -1, audio: null, service: "diffrhythm" };
    }
    return { music_id: id, status: 0, audio: null, service: "diffrhythm" };
}

async function listTasks(cookie: string, featureKey: string): Promise<TaskItem[]> {
    const url = `${TASKS_URL}?${new URLSearchParams({
        featureKey,
        page: "1",
        limit: "20",
        includeTotal: "false",
    })}`;
    const response = await diffrhythmFetch(url, cookie);
    const result = await response.json().catch(() => null) as TaskListResponse | null;
    if (!response.ok) {
        const code = result?.error || response.statusText || "request failed";
        throw new Error(`Failed to get song results from Diffrhythm: ${response.status} ${code}`);
    }
    return result?.data?.items || [];
}

export async function getDiffRhythmSongResults(uids: string[], env: Env): Promise<TransformedSong[]> {
    if (!uids || uids.length === 0) {
        return [];
    }

    const doid = env.DURABLE_OBJECT.idFromName("v0.0.0");
    const stub = env.DURABLE_OBJECT.get(doid);
    const sessionToken = await stub.getDiffrhythmSession(true);
    if (typeof sessionToken !== "string" || !sessionToken) {
        throw new Error("DiffRhythm session is missing");
    }

    const lists = await Promise.all([
        listTasks(sessionToken, TEXT_TO_MUSIC),
        listTasks(sessionToken, LYRICS_TO_MUSIC),
    ]);
    const byId = new Map<string, TaskItem>();
    for (const task of lists.flat()) {
        const id = task._id || task.id;
        if (id) {
            byId.set(id, task);
        }
    }

    return uids.map((uid) => mapTask(uid, byId.get(uid)));
}
