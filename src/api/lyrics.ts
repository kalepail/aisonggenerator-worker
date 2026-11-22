import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getLyrics as getSunoLyrics } from "./suno";
import { songWrite } from "./cf";
import { aisgAuthHeaders } from "./aisonggenerator";
import { hasUnexpectedChinese } from "./language";

// Define the unified response type
export interface UnifiedLyricsResponse {
    title: string | null;
    lyrics: string | null;
    style: string[];
    service: string;
}

// Service definition for cleaner iteration
interface LyricsService {
    name: string;
    fetch: (prompt: string, env: Env) => Promise<UnifiedLyricsResponse>;
}

export const AISG_LYRICS_MAX_ATTEMPTS = 3;

const LANGUAGE_RETRY_REMINDER =
    "\n\nIMPORTANT: Write the title, lyrics, and style tags strictly in the exact language of the prompt above. Do not switch to another language.";

async function fetchAisgLyricsOnce(prompt: string, env: Env): Promise<UnifiedLyricsResponse> {
    const res = await fetch("https://aisonggenerator.io/api/music/lyrics/generate", {
        method: "POST",
        headers: aisgAuthHeaders(env, true),
        body: JSON.stringify({
            action: "generate",
            model: "openrouter/auto",
            prompt,
        }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`Lyric generation request failed (HTTP ${res.status})`);
    }
    const response = await res.json().catch(() => null) as {
        title?: unknown; lyrics?: unknown; tags?: unknown; style?: unknown;
    } | null;
    const tagText = typeof response?.tags === "string"
        ? response.tags
        : (typeof response?.style === "string" ? response.style : "");
    const style = tagText.split(",").map((item: string) => item.trim()).filter(Boolean);
    if (typeof response?.lyrics === "string" && response.lyrics.trim()
        && typeof response.title === "string" && response.title.trim() && style.length > 0) {
        return {
            title: response.title.trim(),
            service: "aisonggenerator.io",
            lyrics: response.lyrics.trim(),
            style,
        };
    }
    throw new Error("Response missing lyrics, title, or tags");
}

const lyricsServices: LyricsService[] = [
    {
        name: "aisonggenerator.io",
        fetch: async (prompt, env) => {
            for (let attempt = 1; attempt <= AISG_LYRICS_MAX_ATTEMPTS; attempt++) {
                const attemptPrompt = attempt === 1 ? prompt : `${prompt}${LANGUAGE_RETRY_REMINDER}`;
                const result = await fetchAisgLyricsOnce(attemptPrompt, env);
                if (!hasUnexpectedChinese(prompt, result)) {
                    return result;
                }
                console.warn(
                    `aisonggenerator.io attempt ${attempt}/${AISG_LYRICS_MAX_ATTEMPTS} returned unexpected Chinese output`
                );
            }
            throw new Error(
                `aisonggenerator.io returned unexpected Chinese output after ${AISG_LYRICS_MAX_ATTEMPTS} attempts`
            );
        }
    },
    {
        name: "suno",
        fetch: async (prompt, env) => {
            const sunoResponse = await getSunoLyrics(env, prompt);
            if (typeof sunoResponse.text === "string" && sunoResponse.text.trim()
                && typeof sunoResponse.title === "string" && sunoResponse.title.trim()) {
                const result: UnifiedLyricsResponse = {
                    title: sunoResponse.title.trim(),
                    service: "suno",
                    lyrics: sunoResponse.text.trim(),
                    style: Array.isArray(sunoResponse.tags) ? sunoResponse.tags.filter(tag => typeof tag === "string") : [],
                };
                if (hasUnexpectedChinese(prompt, result)) {
                    throw new Error("Suno returned unexpected Chinese output");
                }
                return result;
            }
            throw new Error("Suno response is missing lyrics or title");
        }
    },
    {
        name: "cloudflare-ai",
        fetch: async (prompt, env) => ({ ...await songWrite(env, prompt), service: "cloudflare-ai" }),
    }
];

export async function generateLyricsWithFallback(prompt: string, env: Env): Promise<UnifiedLyricsResponse> {
    const errors: string[] = [];

    for (const service of lyricsServices) {
        try {
            console.log(`Attempting lyrics generation with ${service.name}...`);
            const result = await service.fetch(prompt, env);
            console.log(`Successfully generated lyrics with ${service.name}`);
            return result;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`${service.name} failed: ${errorMsg}`);
            errors.push(`${service.name}: ${errorMsg}`);
        }
    }

    console.error("All lyrics services failed:", errors);
    throw new HTTPException(500, { message: `All lyric generation services failed. Errors: ${errors.join("; ")}` });
}

export async function lyrics(ctx: Context<{ Bindings: Env }>) {
    const { req } = ctx;
    const requestBody = await req.text();
    let prompt: string | undefined;

    try {
        const parsedBody = JSON.parse(requestBody);
        prompt = parsedBody.prompt;
    } catch {
        // If parsing fails, assume the body itself is the prompt string
        prompt = requestBody;
    }

    const result = await generateLyricsWithFallback(prompt || "", ctx.env);
    return ctx.json(result);
}
