import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getLyrics as getSunoLyrics, LyricsStatusResponse } from "./suno"; // Import Suno functions
import { songWrite } from "./cf"; // Import songWrite
import { aisgAuthHeaders } from "./aisonggenerator";

// Define the unified response type
interface UnifiedLyricsResponse {
    title: string | null;
    lyrics: string | null;
    style: string[];
    service: string;
}

// Service definition for cleaner iteration
interface LyricsService {
    name: string;
    fetch: (prompt: string, requestBody: string, env: Env) => Promise<UnifiedLyricsResponse | null>;
}

const lyricsServices: LyricsService[] = [
    {
        name: "aisonggenerator.io",
        fetch: async (prompt, _requestBody, env) => {
            const res = await fetch('https://aisonggenerator.io/api/music/lyrics/generate', {
                method: 'POST',
                headers: aisgAuthHeaders(env, true),
                body: JSON.stringify({
                    action: 'generate',
                    model: 'openrouter/auto',
                    prompt,
                }),
            });
            const response: any = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${response?.error || ''}`.trim());
            }
            const tagText = typeof response?.tags === 'string'
                ? response.tags
                : (typeof response?.style === 'string' ? response.style : '');
            const style = tagText.split(',').map((item: string) => item.trim()).filter(Boolean);
            if (response?.lyrics && response?.title && style.length > 0) {
                return {
                    title: response.title,
                    service: "aisonggenerator.io",
                    lyrics: response.lyrics,
                    style,
                };
            }
            throw new Error("Response missing lyrics, title, or tags");
        }
    },
    {
        name: "suno",
        fetch: async (prompt) => {
            const sunoResponse: LyricsStatusResponse = await getSunoLyrics(prompt);
            if (sunoResponse.status === 'complete' && sunoResponse.text && sunoResponse.title) {
                return {
                    title: sunoResponse.title,
                    service: "suno",
                    lyrics: sunoResponse.text,
                    style: sunoResponse.tags || [],
                };
            }
            throw new Error(`Suno status: ${sunoResponse.status}, error: ${sunoResponse.error_message || 'no lyrics/title'}`);
        }
    },
    {
        name: "cloudflare-ai",
        fetch: async (prompt, _requestBody, env) => {
            const cfApiResponse = await songWrite(env, prompt || "");
            const response = (cfApiResponse as any)?.response;
            if (!response) {
                throw new Error("Cloudflare AI returned empty response");
            }

            // JSON mode returns a parsed object directly; fall back to string parsing
            let parsed: any;
            if (typeof response === 'object') {
                parsed = response;
            } else if (typeof response === 'string') {
                // Strip markdown code fences if present
                const cleaned = response.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
                try {
                    parsed = JSON.parse(cleaned);
                } catch {
                    throw new Error(`Failed to parse Cloudflare AI response: ${cleaned.substring(0, 200)}`);
                }
            } else {
                throw new Error("Cloudflare AI returned unexpected response type");
            }

            if (parsed.title && parsed.lyrics && Array.isArray(parsed.style)) {
                return {
                    title: parsed.title.trim(),
                    service: "cloudflare-ai",
                    lyrics: parsed.lyrics.trim(),
                    style: parsed.style,
                };
            }
            throw new Error("Cloudflare AI response missing title, lyrics, or style array");
        }
    }
];

export async function lyrics(ctx: Context<{ Bindings: Env }>) {
    const { req } = ctx;
    const requestBody = await req.text();
    let prompt: string | undefined;

    try {
        const parsedBody = JSON.parse(requestBody);
        prompt = parsedBody.prompt;
    } catch (e) {
        // If parsing fails, assume the body itself is the prompt string
        prompt = requestBody;
    }

    const errors: string[] = [];

    for (const service of lyricsServices) {
        try {
            console.log(`Attempting lyrics generation with ${service.name}...`);
            const result = await service.fetch(prompt || "", requestBody, ctx.env);
            if (result) {
                console.log(`Successfully generated lyrics with ${service.name}`);
                return ctx.json(result);
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`${service.name} failed: ${errorMsg}`);
            errors.push(`${service.name}: ${errorMsg}`);
            // Continue to next service
        }
    }

    // All services failed
    console.error("All lyrics services failed:", errors);
    throw new HTTPException(500, { message: `All lyric generation services failed. Errors: ${errors.join('; ')}` });
}
