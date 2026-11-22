const CLERK_CLIENT_URL = "https://clerk.suno.com/v1/client";
const CLERK_QUERY = "_clerk_js_version=5.117.0&__clerk_api_version=2025-11-10";
const LYRICS_API_BASE_URL = "https://studio-api.prod.suno.com/api";
const REQUEST_TIMEOUT_MS = 10000;

interface ClerkClientResponse {
    response?: {
        last_active_session_id?: string | null;
        sessions?: Array<{ id: string; status: string }>;
    };
}

interface LyricsGenerationResponse {
    id: string;
}

export interface LyricsStatusResponse {
    text: string | null;
    title: string | null;
    status: string;
    error_message: string | null;
    tags: string[] | null;
}

export async function getClerkToken(env: Env): Promise<string> {
    const cookie = env.SUNO_SESSION_TOKEN?.trim();
    if (!cookie) {
        throw new Error("SUNO_SESSION_TOKEN is missing");
    }
    const headers = { Cookie: `__client=${cookie}` };
    const clientResponse = await fetch(`${CLERK_CLIENT_URL}?${CLERK_QUERY}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!clientResponse.ok) {
        throw new Error(`Suno Clerk client request failed (HTTP ${clientResponse.status})`);
    }

    const data = await clientResponse.json().catch(() => null) as ClerkClientResponse | null;
    const client = data?.response;
    const activeSessions = Array.isArray(client?.sessions)
        ? client.sessions.filter(session => session?.status === "active")
        : [];
    const session = activeSessions.find(session => session.id === client?.last_active_session_id) ?? activeSessions[0];
    if (typeof session?.id !== "string" || !session.id) {
        throw new Error("Suno Clerk client has no active session");
    }

    const sessionId = encodeURIComponent(session.id);
    const response = await fetch(`${CLERK_CLIENT_URL}/sessions/${sessionId}/tokens?${CLERK_QUERY}`, {
        method: 'POST',
        headers: { ...headers, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Suno Clerk token request failed (HTTP ${response.status})`);
    }
    const token = await response.json().catch(() => null) as { jwt?: unknown } | null;
    if (typeof token?.jwt !== "string" || !token.jwt.trim()) {
        throw new Error("Suno Clerk token response is missing a JWT");
    }
    return token.jwt;
}

async function requestLyricGeneration(jwt: string, prompt?: string): Promise<string> {
    const response = await fetch(`${LYRICS_API_BASE_URL}/generate/lyrics`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwt}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
            prompt: prompt || "",
            lyrics_model: "default"
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Suno lyric generation request failed (HTTP ${response.status})`);
    }
    const data = await response.json().catch(() => null) as LyricsGenerationResponse | null;
    if (typeof data?.id !== "string" || !data.id) {
        throw new Error("Suno lyric generation response is missing an ID");
    }
    return data.id;
}

export async function getLyrics(env: Env, prompt?: string): Promise<LyricsStatusResponse> {
    let clerkJwt = await getClerkToken(env);
    const lyricRequestId = await requestLyricGeneration(clerkJwt, prompt);
    const pollUrl = `${LYRICS_API_BASE_URL}/generate/lyrics/${encodeURIComponent(lyricRequestId)}`;
    const deadline = Date.now() + 60000;
    const pollInterval = 5000;
    let renewedToken = false;

    while (Date.now() + pollInterval < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            break;
        }
        const response = await fetch(pollUrl, {
            headers: { Authorization: `Bearer ${clerkJwt}` },
            signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        }).catch(() => null);
        if (response?.status === 401 && !renewedToken) {
            clerkJwt = await getClerkToken(env);
            renewedToken = true;
            continue;
        }
        if (response?.status === 401 || response?.status === 403) {
            throw new Error(`Suno lyric status request failed (HTTP ${response.status})`);
        }
        if (!response?.ok) {
            continue;
        }
        const data = await response.json().catch(() => null) as LyricsStatusResponse | null;
        if (data?.status === "complete") {
            return data;
        }
        if (data?.status === "error" || data?.status === "failed") {
            throw new Error("Suno lyric generation failed");
        }
    }

    throw new Error("Suno lyric generation timed out");
}
